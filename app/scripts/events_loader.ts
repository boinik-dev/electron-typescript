import fs from 'fs';
import rimraf from 'rimraf';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import dayjs from 'dayjs';
import jimp from 'jimp';
import Async from 'async';
import axios from 'axios';

import { App, ipcMain, BrowserWindow, IpcMainEvent } from 'electron';
import { Session } from '../types/Session';
import { processVideo } from './video';

import { Result, Summary, Photo } from '../types/Result';

import {
  loadMapillarySessionData,
  findSequences,
} from './integrations/mapillary';

import { loadImages, updateImages, addLogo, modifyLogo } from './image';
import tokenStore from './tokens';

import {
  sendToClient,
  sendPoints,
  createdData2List,
  resultdirectorypath,
  getSequenceLogPath,
  getSequenceGpxPath,
  getSequenceBasePath,
  getOriginalBasePath,
  errorHandler,
  resetSequence,
  removeTempFiles,
} from './utils';

import { readGPX } from './utils/gpx';

import loadCameras from './camera';
import loadIntegrations from './integration';
import loadDefaultNadir from './nadir';

axios.interceptors.response.use(
  (res) => res,
  (err) => {
    throw err;
  }
);

export default (mainWindow: BrowserWindow, app: App) => {
  const basepath = app.getAppPath();

  ipcMain.on(
    'set_token',
    (_event: IpcMainEvent, key: string, token: string) => {
      tokenStore.set(key, token);
    }
  );

  ipcMain.once('load_config', async (_event: IpcMainEvent) => {
    const [cameras, nadirs, integrations] = await Promise.all([
      loadCameras(app),
      loadDefaultNadir(app),
      loadIntegrations(app),
    ]);
    console.log(tokenStore.getAll());
    sendToClient(mainWindow, 'loaded_config', {
      cameras,
      nadirs,
      integrations,
      basepath,
      tokens: tokenStore.getAll(),
    });
  });

  ipcMain.on(
    'load_video',
    async (
      _event: IpcMainEvent,
      videoPath: string,
      seqname: string,
      corrupted: boolean
    ) => {
      if (!fs.existsSync(resultdirectorypath(app))) {
        fs.mkdirSync(resultdirectorypath(app));
      }
      const sequencebasepath = getSequenceBasePath(seqname, basepath);
      if (fs.existsSync(sequencebasepath)) {
        await rimraf.sync(sequencebasepath);
      }
      fs.mkdirSync(sequencebasepath);

      processVideo(
        mainWindow,
        videoPath,
        getOriginalBasePath(seqname, basepath),
        corrupted
      );
    }
  );

  ipcMain.on(
    'load_images',
    async (
      _event: IpcMainEvent,
      dirPath: string,
      seqname: string,
      corrupedCheck: boolean
    ) => {
      if (!fs.existsSync(resultdirectorypath(app))) {
        try {
          fs.mkdirSync(resultdirectorypath(app));
        } catch (e) {
          errorHandler(mainWindow, e);
          return;
        }
      }

      const imageLength = fs
        .readdirSync(dirPath)
        .filter(
          (name: string) =>
            !name.toLowerCase().endsWith('.png') &&
            !name.toLowerCase().endsWith('.jpeg') &&
            !name.toLowerCase().endsWith('.jpg')
        ).length;

      if (imageLength) {
        errorHandler(mainWindow, 'The images should be jpeg or jpg');
        return;
      }

      if (
        fs
          .readdirSync(dirPath)
          .filter(
            (name: string) =>
              name.toLowerCase().endsWith('.png') ||
              name.toLowerCase().endsWith('.jpeg') ||
              name.toLowerCase().endsWith('.jpg')
          ).length === 1
      ) {
        errorHandler(
          mainWindow,
          'More than one image is required to create a sequence.'
        );
        return;
      }

      loadImages(
        dirPath,
        getSequenceBasePath(seqname, basepath),
        corrupedCheck,
        (error: any, result: any) => {
          if (error) {
            errorHandler(mainWindow, error);
          } else {
            const { points, removedfiles } = result;
            sendPoints(mainWindow, points);

            if (removedfiles.length) {
              sendToClient(mainWindow, 'removed_files', removedfiles);
            }
            if (points.length) sendToClient(mainWindow, 'finish');
          }
        }
      );
    }
  );

  ipcMain.on('load_gpx', (_event: IpcMainEvent, gpxpath: string) => {
    readGPX(gpxpath, (err: any, points: any) => {
      if (!err) {
        sendToClient(mainWindow, 'loaded_gpx', points);
      } else {
        errorHandler(mainWindow, err);
      }
    });
  });

  ipcMain.on(
    'upload_nadir',
    (_event: IpcMainEvent, { nadirpath, imagepath, width, height }) => {
      const results: {
        [key: string]: any;
      } = {};
      const templogofile = path.resolve(basepath, `../${uuidv4()}.png`);

      const modifyLogoAsync = modifyLogo(nadirpath, templogofile)
        .then(() => {
          return jimp.read(templogofile);
        })
        .catch((err) => errorHandler(mainWindow, err));

      modifyLogoAsync
        .then((logo: any) => {
          return Async.eachOfLimit(
            Array(16),
            1,
            (_item: unknown, key: any, cb: CallableFunction) => {
              const outputfile = path.resolve(basepath, `../${uuidv4()}.png`);
              const percentage = (10 + key) / 100;
              // const percentage = 0.15;
              const logoHeight = Math.round(height * percentage);

              logo.resize(width, logoHeight);
              // eslint-disable-next-line promise/no-nesting
              const addLogoAsync = addLogo(
                imagepath,
                logo,
                0,
                height - logoHeight
              )
                .then((image: any) => image.writeAsync(outputfile))
                .catch((err: any) => {
                  errorHandler(mainWindow, err);
                  cb(err);
                });

              // eslint-disable-next-line promise/no-nesting
              addLogoAsync
                .then(() => {
                  results[percentage.toString()] = outputfile;
                  return cb();
                })
                .catch((err: any) => cb(err));
            },
            (err) => {
              if (err) {
                errorHandler(mainWindow, err);
              } else {
                sendToClient(mainWindow, 'loaded_preview_nadir', {
                  logofile: templogofile,
                  items: results,
                });
              }
            }
          );
          // return addLogo(imagepath, logo, 0, height - logoHeight);
        })
        .catch((err) => errorHandler(mainWindow, err));
    }
  );

  ipcMain.on('update_images', async (_event: IpcMainEvent, sequence: any) => {
    // eslint-disable-next-line global-require
    const { buildGPX, GarminBuilder } = require('gpx-builder');
    const { Point } = GarminBuilder.MODELS;

    const logo =
      sequence.steps.previewnadir.logofile !== ''
        ? await jimp.read(sequence.steps.previewnadir.logofile)
        : null;
    if (sequence.steps.previewnadir.logofile !== '' && logo) {
      logo.resize(
        sequence.points[0].width,
        sequence.points[0].height * sequence.steps.previewnadir.percentage
      );
    }

    let mapillarySessionData = null;

    if (sequence.steps.destination.mapillary) {
      const sessionData: Session = await loadMapillarySessionData(
        tokenStore.get('mapillary')
      );
      if (sessionData.error) {
        return errorHandler(mainWindow, sessionData.error);
      }
      if (sessionData.data) {
        mapillarySessionData = sessionData.data;
      }
    }
    const resultjson: Result = await updateImages(
      sequence.points,
      sequence.steps,
      logo,
      basepath,
      mapillarySessionData
    );

    if (mapillarySessionData) {
      const mapillarySessionKey = mapillarySessionData.key;

      resultjson.sequence.destination.mapillary = mapillarySessionKey;
    }

    fs.writeFileSync(
      getSequenceLogPath(sequence.steps.name, basepath),
      JSON.stringify(resultjson)
    );

    await removeTempFiles(app);

    const gpxData = new GarminBuilder();

    const points = Object.values(resultjson.photo).map((p: Photo) => {
      return new Point(p.MAPLatitude, p.MAPLongitude, {
        ele: p.MAPAltitude,
        time: dayjs(p.GPSDateTime).toDate(),
      });
    });

    gpxData.setSegmentPoints(points);

    fs.writeFileSync(
      getSequenceGpxPath(sequence.steps.name, basepath),
      buildGPX(gpxData.toObject())
    );

    return sendToClient(mainWindow, 'add-seq', createdData2List(resultjson));
  });

  ipcMain.once('sequences', async (_event: IpcMainEvent) => {
    if (!fs.existsSync(resultdirectorypath(app))) {
      fs.mkdirSync(resultdirectorypath(app));
    }
    const sequencesDirectories = fs
      .readdirSync(resultdirectorypath(app))
      .filter(
        (name) =>
          fs.lstatSync(getSequenceBasePath(name, basepath)).isDirectory() &&
          fs.existsSync(getSequenceLogPath(name, basepath))
      );

    fs.readdirSync(resultdirectorypath(app))
      .filter(
        (name) =>
          fs.lstatSync(getSequenceBasePath(name, basepath)).isDirectory() &&
          !fs.existsSync(getSequenceLogPath(name, basepath))
      )
      .forEach((d: string) => {
        rimraf.sync(getSequenceBasePath(d, basepath));
      });

    const sequences: Result[] = sequencesDirectories
      .map((name: string) => {
        return JSON.parse(
          fs.readFileSync(getSequenceLogPath(name, basepath)).toString()
        );
      })
      .sort((a: any, b: any) => {
        return dayjs(a.created).isBefore(dayjs(b.created)) ? 1 : -1;
      });

    // const summaries: Summary[] = sequences.map((s: Result) =>
    //   createdData2List(s)
    // );

    const summaries: Summary[] = await Promise.all(
      sequences.map(async (s: Result) => {
        const summary = createdData2List(s);
        if (
          s.sequence.destination &&
          s.sequence.destination.mapillary &&
          s.sequence.destination.mapillary !== ''
        ) {
          const { error, data } = await findSequences(
            tokenStore.get('mapillary'),
            s.sequence.destination.mapillary,
            s.photo
          );
          if (data) {
            summary.destination.mapillary = '';
          } else if (error) {
            summary.destination.mapillary = `Error: ${error}`;
          }
        }
        return summary;
      })
    );

    sendToClient(mainWindow, 'loaded_sequences', summaries);
  });

  ipcMain.on('remove_sequence', async (_event: IpcMainEvent, name: string) => {
    if (fs.existsSync(getSequenceBasePath(name, basepath))) {
      rimraf.sync(getSequenceBasePath(name, basepath));
    }
  });

  ipcMain.on('reset_sequence', async (_event, sequence) => {
    await resetSequence(sequence, app);
    await removeTempFiles(app);
  });

  ipcMain.on('closed_app', async (_event, sequence) => {
    if (sequence) {
      await resetSequence(sequence, app);
    }
    await removeTempFiles(app);
    mainWindow?.destroy();
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
};
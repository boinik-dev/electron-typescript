/* eslint global-require: off, no-console: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `yarn build` or `yarn build-main`, this file is compiled to
 * `./app/main.prod.js` using webpack. This gives us some performance wins.
 */
import { app, BrowserWindow, ipcMain, IpcMainEvent, dialog } from 'electron';

import fs from 'fs';
import rimraf from 'rimraf';
import dotenv from 'dotenv';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

import { processVideo } from './scripts/video';
import { loadImages, updateImages, addLogo } from './scripts/image';
import { sendToClient, sendPoints, createdData2List } from './scripts/utils';
import { readGPX } from './scripts/utils/gpx';
import { Results, Summary } from './types/Result';
import loadCameras from './scripts/camera';

let mainWindow: BrowserWindow | null = null;
dotenv.config();

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

if (
  process.env.NODE_ENV === 'development' ||
  process.env.DEBUG_PROD === 'true'
) {
  require('electron-debug')();
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS', 'REDUX_DEVTOOLS'];

  return Promise.all(
    extensions.map((name) => installer.default(installer[name], forceDownload))
  ).catch(console.log);
};

const createWindow = async () => {
  if (
    process.env.NODE_ENV === 'development' ||
    process.env.DEBUG_PROD === 'true'
  ) {
    await installExtensions();
  }

  mainWindow = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: {
      nodeIntegration: true,
    },
  });

  mainWindow.loadURL(`file://${__dirname}/app.html`);

  // @TODO: Use 'ready-to-show' event
  //        https://github.com/electron/electron/blob/master/docs/api/browser-window.md#using-ready-to-show-event
  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('close', async (e) => {
    const response = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Yes', 'No'],
      title: 'Confirm',
      message: 'Are you sure you want to quit?',
    });
    if (response === 1) {
      e.preventDefault();
    }
  });

  // const menuBuilder = new MenuBuilder(mainWindow);
  // menuBuilder.buildMenu();
};

/**
 * Add event listeners for ipcMain
 */
ipcMain.on('load_config', async (_event: IpcMainEvent) => {
  const cameras = await loadCameras(app);
  sendToClient(mainWindow, 'loaded_config', { cameras });
});

ipcMain.on(
  'load_videos',
  (_event: IpcMainEvent, videoPath: string, outputPath: string) => {
    processVideo(mainWindow, videoPath, outputPath);
  }
);

ipcMain.on(
  'load_images',
  (_event: IpcMainEvent, dirPath: string, outputpath: string) => {
    loadImages(dirPath, outputpath, (error: any, result: any) => {
      if (error) {
        sendToClient(mainWindow, 'error', error.message);
      } else {
        const { points, removedfiles } = result;
        if (points.length) {
          sendPoints(mainWindow, points);
        }

        if (removedfiles.length) {
          sendToClient(mainWindow, 'removed_files', removedfiles);
        }

        sendToClient(mainWindow, 'finish');
      }
    });
  }
);

ipcMain.on('load_gpx', (_event: IpcMainEvent, gpxpath: string) => {
  readGPX(gpxpath, (err: any, points: any) => {
    if (!err) {
      sendToClient(mainWindow, 'loaded_gpx', points);
    }
  });
});

ipcMain.on('upload_nadir', (_event: IpcMainEvent, { nadirpath, imagepath }) => {
  console.log(imagepath, nadirpath);
  const tempfilename = uuidv4();
  const outputfile = path.resolve(app.getAppPath(), '../', tempfilename);
  const addLogoAsync = addLogo(imagepath, nadirpath)
    .then((image) => {
      return image.writeAsync(outputfile);
    })
    .catch((err) => {
      console.error(err);
    });

  addLogoAsync
    .then(() => sendToClient(mainWindow, 'loaded_preview_nadir', outputfile))
    .catch((err) => console.error(err));
});

const log = path.resolve(app.getAppPath(), '../result.json');

ipcMain.on('update_images', async (_event: IpcMainEvent, sequence: any) => {
  let result: Results = {};
  if (fs.existsSync(log)) {
    result = JSON.parse(fs.readFileSync(log).toString());
  }

  updateImages(sequence.points, sequence.steps)
    .then((resultjson: any) => {
      const sequenceid = resultjson.sequence.id;
      result[sequenceid] = resultjson;
      fs.writeFileSync(log, JSON.stringify(result));

      return sendToClient(mainWindow, 'add-seq', createdData2List(resultjson));
    })
    .catch((err) => {
      sendToClient(mainWindow, 'error', err);
    });
});

ipcMain.on('sequences', async (_event: IpcMainEvent) => {
  console.log('logPath:', log);
  if (!fs.existsSync(log)) {
    sendToClient(mainWindow, 'loaded-sequences', []);
  } else {
    const logdata = JSON.parse(fs.readFileSync(log).toString());
    const result: Summary[] = [];

    Object.keys(logdata).forEach(async (id: string) => {
      if (fs.existsSync(logdata[id].sequence.uploader_sequence_name)) {
        result.push(createdData2List(logdata[id]));
      }
    });
    sendToClient(mainWindow, 'loaded-sequences', result);
  }
});

ipcMain.on('remove_sequence', async (_event: IpcMainEvent, id: string) => {
  let result: Results = {};
  if (fs.existsSync(log)) {
    result = JSON.parse(fs.readFileSync(log).toString());
  }
  if (result[id]) {
    const name = result[id].sequence.uploader_sequence_name;
    if (fs.existsSync(name)) {
      rimraf.sync(name);
    }
    const storefile = `${name}.json`;
    if (fs.existsSync(storefile)) {
      fs.unlinkSync(storefile);
    }
    delete result[id];
    fs.writeFileSync(log, JSON.stringify(result));
  }
});

/**
 * Add event listeners...
 */

app.on('window-all-closed', () => {
  // Respect the OSX convention of having the application in memory even
  // after all windows have been closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('ready', createWindow);

app.on('activate', () => {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) createWindow();
});

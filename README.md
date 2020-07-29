# Map the Paths Desktop Uploader

## About

Map the Paths Desktop Uploader allows you to:

1. Process your cartesian or equirectangular photos into a virtual tour
  - Add / modify positioning
  - Modify headings
  - Add a custom nadir
  - Add metadata (e.g. transport method, object detections...)
2. Creates a series of output files that includes
  - Final tour imagery
  - GPX track
  - Sequence (tour) JSON file
3. Published to Map the Paths
  - Which can then be used to publish to Google Street View, Mapillary, etc.

[Download the latest version here](https://www.mapthepaths.com/desktop-uploader).

## Dev Docs

### Environment / build setup

#### Prerequisties

Requires

* [Yarn](https://classic.yarnpkg.com/en/)
* [NodeJS](https://nodejs.org/)

#### Install

```
yarn
```

#### Starting Development

Start the app in the `dev` environment. This starts the renderer process in [**hot-module-replacement**](https://webpack.js.org/guides/hmr-react/) mode and starts a webpack dev server that sends hot updates to the renderer process:

```
yarn dev
```

#### Packaging for Production

To package apps for the local platform:

```
yarn package
```

## License

OPM Desktop Uploader is licensed under a [GNU AGPLv3 License](/LICENSE.txt).

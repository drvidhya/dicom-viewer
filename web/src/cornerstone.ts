import {
  init as csRenderInit,
  volumeLoader,
  metaData,
  cornerstoneStreamingImageVolumeLoader,
} from '@cornerstonejs/core';
import { init as csToolsInit } from '@cornerstonejs/tools';
import * as dicomImageLoader from '@cornerstonejs/dicom-image-loader';

export async function initCornerstone(): Promise<void> {
  dicomImageLoader.init({ maxWebWorkers: 0 });
  metaData.addProvider(
    (dicomImageLoader as any).wadouri.metaData.metaDataProvider,
    10000,
  );
  volumeLoader.registerVolumeLoader(
    'cornerstoneStreamingImageVolume',
    cornerstoneStreamingImageVolumeLoader as any,
  );
  await csRenderInit();
  await csToolsInit();
}

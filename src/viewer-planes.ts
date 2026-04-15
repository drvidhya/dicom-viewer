import { Enums } from '@cornerstonejs/core';

export const PLANE_IDS = ['axial', 'sagittal', 'coronal'] as const;
export type PlaneId = (typeof PLANE_IDS)[number];

export const ORIENTATION_MAP: Record<PlaneId, Enums.OrientationAxis> = {
  axial:    Enums.OrientationAxis.AXIAL,
  sagittal: Enums.OrientationAxis.SAGITTAL,
  coronal:  Enums.OrientationAxis.CORONAL,
};

export const VIEW_LABELS: Record<PlaneId, string> = {
  axial:    'Axial',
  sagittal: 'Sagittal',
  coronal:  'Coronal',
};

export const VIEW_COLORS_HEX: Record<PlaneId, string> = {
  axial:    '#00d4aa',
  sagittal: '#ff6b9d',
  coronal:  '#7c5cff',
};

import { metaData } from '@cornerstonejs/core';

export type DicomStudyMeta = {
  patientName:      string;
  studyDescription: string;
  seriesDesc:       string;
  modality:         string;
  nSlices:          number;
  matrix:           string;
};

export function getDicomStudyMeta(imageId: string, nSlices: number): DicomStudyMeta {
  const pm = metaData.get('patientModule',      imageId) ?? {};
  const sm = metaData.get('generalStudyModule',  imageId) ?? {};
  const se = metaData.get('generalSeriesModule', imageId) ?? {};
  const px = metaData.get('imagePixelModule',    imageId) ?? {};

  return {
    patientName:      String(pm.patientName ?? '—'),
    studyDescription: String(sm.studyDescription ?? '—'),
    seriesDesc:       String(se.seriesDescription ?? '—'),
    modality:         String(se.modality ?? '—'),
    nSlices,
    matrix:           px.columns && px.rows ? `${px.columns} × ${px.rows}` : '—',
  };
}

function escHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Rows for `#dicom-info` (2D dashboard). */
export function formatDicomMetaRowsHtml(meta: DicomStudyMeta): string {
  const row = (label: string, value: string) =>
    `<div class="meta-row"><span class="meta-lbl">${label}</span><span class="meta-val">${escHtml(value)}</span></div>`;
  return [
    row('Patient',  meta.patientName),
    row('Study',    meta.studyDescription),
    row('Series',   meta.seriesDesc),
    row('Modality', meta.modality),
    row('Slices',   String(meta.nSlices)),
    row('Matrix',   meta.matrix),
  ].join('');
}

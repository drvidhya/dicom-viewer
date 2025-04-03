package com.nparashuram.dicomviewer.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import com.meta.spatial.compose.composePanel
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.Vector3
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.Grabbable
import com.meta.spatial.toolkit.PanelRegistration
import com.meta.spatial.toolkit.SpatialActivityManager
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.createPanelEntity
import com.nparashuram.dicomviewer.data.PDicomViewModel
import com.nparashuram.dicomviewer.data.Plane
import com.nparashuram.dicomviewer.ui.components.DownloadStatus
import com.nparashuram.dicomviewer.ui.components.ImageSlice
import com.nparashuram.dicomviewer.ui.components.ImageSliceSelector


@Composable
fun ViewerScreen(location: String, viewModel: PDicomViewModel, onClose: () -> Unit) {
    val selectedPDicom = viewModel.selectedPDicom.collectAsState().value
    val selectedSliceIndex = viewModel.selectedSliceIndex.collectAsState().value
    val selectedSliceImg = viewModel.selectedSliceImg.collectAsState().value

    if (selectedPDicom == null) {
        Column {
            DownloadStatus(location, viewModel::selectPDicom)
            Button(onClick = { onClose() }) { Text("Cancel") }
        }
    } else {
        Column {
            Plane.entries.map { plane ->
                selectedSliceIndex[plane]?.let {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(text = plane.name)
                        ImageSliceSelector(
                            plane,
                            selectedSliceIndex[plane] ?: 0,
                            selectedPDicom.files.getSlice(plane).size
                        ) { plane, value, context ->
                            viewModel.updateSelectedSlice(plane, value, context)
                        }
                    }
                }

            }
        }
        SpatialActivityManager.executeOnVrActivity<AppSystemActivity> { immersiveActivity ->
            Plane.entries.forEachIndexed { index, plane ->
                val panelId = 300 + index
                Entity.createPanelEntity(
                    panelId,
                    Transform(Pose(Vector3(index.toFloat() -1f, 2f, 2f), Quaternion(0f, 180f, 0f))),
                    Grabbable(),
                )
                immersiveActivity.registerPanel(PanelRegistration(panelId) {
                    composePanel {
                        setContent {
                            ImageSlice(plane, selectedSliceImg[plane])
                        }
                    }
                })
            }
        }
    }
}

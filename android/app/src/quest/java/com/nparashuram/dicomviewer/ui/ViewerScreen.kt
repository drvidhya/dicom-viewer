package com.nparashuram.dicomviewer.ui

import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalContext
import com.meta.spatial.compose.composePanel
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.Vector3
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.Color4
import com.meta.spatial.toolkit.Grabbable
import com.meta.spatial.toolkit.Material
import com.meta.spatial.toolkit.Mesh
import com.meta.spatial.toolkit.PanelRegistration
import com.meta.spatial.toolkit.Scale
import com.meta.spatial.toolkit.SpatialActivityManager
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.createPanelEntity
import com.nparashuram.dicomviewer.data.PDicomViewModel
import com.nparashuram.dicomviewer.data.Plane
import com.nparashuram.dicomviewer.ui.components.DownloadStatus
import com.nparashuram.dicomviewer.ui.components.ImageSlice
import com.nparashuram.dicomviewer.ui.components.ImageSliceSelector
import kotlin.io.path.Path
import kotlin.io.path.div


@Composable
fun ViewerScreen(location: String, viewModel: PDicomViewModel, onClose: () -> Unit) {
    val selectedPDicom = viewModel.selectedPDicom.collectAsState().value

    val filesDir = LocalContext.current.filesDir

    LaunchedEffect(Unit) {
        SpatialActivityManager.executeOnVrActivity<AppSystemActivity> { immersiveActivity ->
            Plane.entries.forEachIndexed { index, plane ->
                val panelId = 300 + index
                Entity.createPanelEntity(
                    panelId,
                    Transform(
                        Pose(
                            Vector3(index.toFloat() - 1f, 2f, 2f),
                            Quaternion(0f, 180f, 0f)
                        )
                    ),
                    Grabbable(),
                )
                immersiveActivity.registerPanel(PanelRegistration(panelId) {
                    composePanel {
                        setContent {
                            ImageSlice(plane, viewModel)
                        }
                    }
                })
            }
        }
    }

    LaunchedEffect(selectedPDicom) {
        if (selectedPDicom != null) {
            val modelFile = "file://${
                Path(filesDir.path).div("processed-dicom").div(selectedPDicom.storageLocation)
                    .div(selectedPDicom.files.gltf)
            }"
            Entity.create(
                listOf(
                    Mesh(Uri.parse(modelFile)),
                    Transform(
                        Pose(
                            Vector3(0f, 2f, 3f),
                            Quaternion(0f, 0f, 0f)
                        )
                    ),
                    Material().apply {
                        baseColor = Color4(red = 1.0f)
                    },
                    Scale(Vector3(0.002f, 0.002f, 0.002f))
                )
            )
        }
    }

    if (selectedPDicom == null) {
        Column {
            DownloadStatus(location, viewModel::selectPDicom)
            Button(onClick = { onClose() }) { Text("Cancel") }
        }
    } else {
        Column {
            Plane.entries.map { plane ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(text = plane.name)
                    ImageSliceSelector(plane, viewModel)
                }
            }
        }
    }
}

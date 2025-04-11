package com.nparashuram.dicomviewer.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nparashuram.dicomviewer.data.PDicomViewModel
import com.nparashuram.dicomviewer.data.Plane
import com.nparashuram.dicomviewer.ui.components.DownloadStatus
import com.nparashuram.dicomviewer.ui.components.ImageSlice
import com.nparashuram.dicomviewer.ui.components.ImageSliceSelector

@Composable
fun ViewerScreen(location: String, viewModel: PDicomViewModel, onClose: () -> Unit) {
    val selectedPDicom = viewModel.selectedPDicom.collectAsState().value
    val selectedSliceIndex = viewModel.selectedSliceIndex.collectAsState().value

    if (selectedPDicom == null) {
        Column {
            DownloadStatus(location, viewModel::selectPDicom)
            Button(onClick = { onClose() }) { Text("Cancel") }
        }
    } else {
        LazyVerticalGrid(columns = GridCells.Adaptive(minSize = 300.dp)) {
            item(span = { GridItemSpan(this.maxLineSpan) }) {
                Column {
                    Row(
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("Viewer Screen", fontSize = 20.sp, modifier = Modifier.padding(5.dp))
                        OutlinedButton(onClick = { onClose() }) { Text(text = "x") }
                    }
                    Text("Location: $location")
                }
            }
            items(Plane.entries) { plane ->
                selectedSliceIndex[plane]?.let {
                    Row(modifier = Modifier.fillMaxWidth()) {
                        ImageSlice(plane, viewModel)
                    }
                }
            }
            item {
                Column {
                    Plane.entries.map { plane ->
                        selectedSliceIndex[plane]?.let {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(text = plane.name)
                                ImageSliceSelector(plane, viewModel)
                            }
                        }
                    }
                }
            }
        }
    }
}

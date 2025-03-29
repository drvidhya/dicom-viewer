package com.nparashuram.dicomviewer.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.sp
import com.nparashuram.dicomviewer.PDicomViewModel
import com.nparashuram.dicomviewer.StatusCode
import com.nparashuram.dicomviewer.ui.components.ImageSlice

@Composable
fun ViewerScreen(location: String, viewModel: PDicomViewModel, onClose: () -> Unit) {
    val selectedPDicom = viewModel.selectedPDicom.collectAsState().value

    var statusCode: StatusCode? by remember { mutableStateOf(StatusCode.NONE) }
    var statusMessage: String? by remember { mutableStateOf(null) }

    LaunchedEffect(location) {
        viewModel.selectPDicom(location) { code, msg ->
            statusCode = code
            statusMessage = msg
        }
    }

    if (selectedPDicom == null) {
        Column {
            Text("Dicom loading ...")
            Text("Status: [${statusCode}]")
            statusMessage?.let { Text(it) }
            Button(onClick = { onClose() }) { Text("Cancel") }
        }
    } else {
        Column {
            Text("Viewer Screen", fontSize = 20.sp)
            Text("Location: $location")

            ImageSlice("axial", selectedPDicom.axial)
            ImageSlice("coronal", selectedPDicom.coronal)
            ImageSlice("sagittal", selectedPDicom.sagittal)

            Button(onClick = {
                onClose()
            }) {
                Text(text = "Back")
            }
        }
    }
}

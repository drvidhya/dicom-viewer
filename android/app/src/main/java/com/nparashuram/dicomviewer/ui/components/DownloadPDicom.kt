package com.nparashuram.dicomviewer.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.nparashuram.dicomviewer.data.StatusCode
import com.nparashuram.dicomviewer.data.StatusUpdateFn
import kotlin.reflect.KFunction2

@Composable
fun DownloadStatus(location: String, selectPDicom: KFunction2<String, StatusUpdateFn, Unit>) {
    var statusCode: StatusCode? by remember { mutableStateOf(StatusCode.NONE) }
    var statusMessage: String? by remember { mutableStateOf(null) }

    LaunchedEffect(location) {
        selectPDicom(location) { code, msg ->
            statusCode = code
            statusMessage = msg
        }
    }

    Column {
        Text("Dicom loading ...")
        Text("Status: [${statusCode}]")
        statusMessage?.let { Text(it) }
    }
}

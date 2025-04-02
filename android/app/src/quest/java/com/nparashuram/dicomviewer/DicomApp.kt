package com.nparashuram.dicomviewer

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nparashuram.dicomviewer.data.PDicomRepo
import com.nparashuram.dicomviewer.data.PDicomViewModel
import com.nparashuram.dicomviewer.data.PDicomViewModelFactory
import com.nparashuram.dicomviewer.ui.SelectorScreen
import com.nparashuram.dicomviewer.ui.ViewerScreen


@Composable
fun DicomApp(pDicomRepo: PDicomRepo) {
    val viewModel = viewModel<PDicomViewModel>(factory = PDicomViewModelFactory(pDicomRepo))
    var location: String? by remember { mutableStateOf(null) }

    val url = location
    if (url == null) {
        SelectorScreen(viewModel) { l -> location = l }
    } else {
        ViewerScreen(url, viewModel) { location = null }
    }
}

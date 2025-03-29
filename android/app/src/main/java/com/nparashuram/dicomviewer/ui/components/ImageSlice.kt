package com.nparashuram.dicomviewer.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.sp

@Composable
fun ImageSlice(sliceName: String, slices: List<String>) {
    Column {
        Text(fontSize = 20.sp, text = "ImageSlice Renderer")
        Text("Rendering $sliceName")
        Text("Total Slices - ${slices.size}")
    }
}

package com.nparashuram.dicomviewer.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nparashuram.dicomviewer.Plane

@Composable
fun ImageSlice(plane: Plane, slices: List<String>, selectedIndex: Int) {
    Column(modifier = Modifier
        .fillMaxWidth()
        .padding(10.dp)) {
        Text(fontSize = 20.sp, text = "ImageSlice Renderer")
        Text("Rendering ${plane.name}")
        Text("Selected Slice : $selectedIndex > ${slices[selectedIndex]}")
        Text("Total Slices - ${slices.size}")
    }
}

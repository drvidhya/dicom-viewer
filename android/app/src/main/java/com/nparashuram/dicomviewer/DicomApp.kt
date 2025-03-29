package com.nparashuram.dicomviewer

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import com.nparashuram.dicomviewer.data.PDicomRepo
import com.nparashuram.dicomviewer.ui.SelectorScreen
import com.nparashuram.dicomviewer.ui.ViewerScreen
import com.nparashuram.dicomviewer.ui.theme.DicomViewerTheme
import kotlinx.serialization.Serializable

@Serializable
object SelectorRoute

@Serializable
data class ViewerRoute(val url: String)

@Serializable
data class DownloadRoute(val url: String)


@Composable
fun DicomApp(pDicomRepo: PDicomRepo) {
    val viewModel = viewModel<PDicomViewModel>(factory = PDicomViewModelFactory(pDicomRepo))

    DicomViewerTheme {
        Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
            val navController = rememberNavController()
            NavHost(
                navController, startDestination = SelectorRoute,
                modifier = Modifier.padding(innerPadding)
            ) {
                composable<SelectorRoute> {
                    SelectorScreen(viewModel) { url ->
                        navController.navigate(route = ViewerRoute(url = url))
                    }
                }

                composable<ViewerRoute> { backStackEntry ->
                    val url = backStackEntry.toRoute<ViewerRoute>().url
                    ViewerScreen(url, viewModel) {
                        navController.navigate(route = SelectorRoute)
                    }
                }
            }
        }
    }
}

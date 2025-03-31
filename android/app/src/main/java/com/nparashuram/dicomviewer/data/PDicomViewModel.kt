package com.nparashuram.dicomviewer.data

import android.content.Context
import androidx.compose.ui.graphics.ImageBitmap
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

@Serializable
data class PDicomFiles(
    val axial: List<String>,
    val coronal: List<String>,
    val sagittal: List<String>,
    val gltf: String,
) {
    fun getSlice(plane: Plane): List<String> {
        return when (plane) {
            Plane.axial -> axial
            Plane.coronal -> coronal
            Plane.sagittal -> sagittal
        }
    }
}

@Serializable
data class PDicomData(
    val url: String,
    val storageLocation: String,
    val files: PDicomFiles,
)

typealias StatusUpdateFn = (StatusCode, String?) -> Unit

class PDicomViewModel(
    private val pDicomRepo: PDicomRepo,
) : ViewModel() {
    private val _pDicomList = MutableStateFlow(emptyMap<String, String?>())
    val pDicomList: StateFlow<Map<String, String?>> = _pDicomList.asStateFlow()

    private val _selectedPDicom = MutableStateFlow<PDicomData?>(null)
    val selectedPDicom: StateFlow<PDicomData?> = _selectedPDicom.asStateFlow()

    private val _selectedSliceIndex = MutableStateFlow(
        mapOf(
            Plane.axial to 0, Plane.coronal to 0, Plane.sagittal to 0
        )
    )
    val selectedSliceIndex: StateFlow<Map<Plane, Int>> = _selectedSliceIndex.asStateFlow()

    private val _selectedSliceImg = MutableStateFlow<Map<Plane, ImageBitmap?>>(
        mapOf(
            Plane.axial to null, Plane.coronal to null, Plane.sagittal to null
        )
    )
    val selectedSliceImg: StateFlow<Map<Plane, ImageBitmap?>> = _selectedSliceImg.asStateFlow()

    /**
     * Hydrates the _pDicomList from disk
     */
    fun hydrate(updateStatus: StatusUpdateFn) {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                updateStatus(StatusCode.PROGRESS, "Loading data on device")
                val list =
                    pDicomRepo.loadFromDevice { msg -> updateStatus(StatusCode.PROGRESS, msg) }
                _pDicomList.update { it + list }
                updateStatus(StatusCode.SUCCESS, null)
            } catch (e: Exception) {
                updateStatus(StatusCode.ERROR, e.message)
            }
        }
    }

    /**
     * Selects a pDiCom. If not downloaded, also downloads index and slides from url
     */
    fun selectPDicom(url: String, updateStatus: StatusUpdateFn) {
        _selectedPDicom.update { null }
        updateStatus(StatusCode.PROGRESS, "Loading Dicom data")
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val location = _pDicomList.value[url] ?: pDicomRepo.download(url, updateStatus)
                _pDicomList.update { it + (url to location) }
                val pDicomRepo = pDicomRepo.load(location)
                if (pDicomRepo != null) {
                    _selectedPDicom.update { pDicomRepo }
                }
                updateStatus(StatusCode.SUCCESS, null)
            } catch (e: Exception) {
                _selectedPDicom.update { null }
                updateStatus(StatusCode.ERROR, e.message)
            }
        }
    }

    /**
     * Deletes downloaded PDicomData, also removes element from list of selected items
     */
    fun delete(url: String) {
        val storageLocation = pDicomList.value[url]
        val done = storageLocation?.let { pDicomRepo.remove(it) }
        if (done == true) _pDicomList.update { it.minus(url) }
    }

    fun updateSelectedSlice(plane: Plane, value: Int, context: Context) {
        viewModelScope.launch(Dispatchers.IO) {
            _selectedSliceIndex.update { it + (plane to value) }

            val pDicom = _selectedPDicom.value
            val slice = pDicom?.files?.getSlice(plane)
            val storageLocation = pDicom?.storageLocation
            if (slice != null && storageLocation != null) {
                val img = pDicomRepo.loadImage(
                    storageLocation, pDicom.files.getSlice(plane)[value], context
                )
                _selectedSliceImg.update { it + (plane to img) }
            }
        }
    }
}

@Suppress("UNCHECKED_CAST")
class PDicomViewModelFactory(private val pDicomRepo: PDicomRepo) :
    ViewModelProvider.NewInstanceFactory() {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        return PDicomViewModel(pDicomRepo) as T
    }
}

enum class StatusCode {
    ERROR, PROGRESS, SUCCESS, NONE
}

enum class Plane {
    axial, coronal, sagittal
}

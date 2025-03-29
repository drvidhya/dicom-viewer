package com.nparashuram.dicomviewer

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.nparashuram.dicomviewer.data.PDicomRepo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

@Serializable
data class PDicomData(
    val axial: List<String>,
    val coronal: List<String>,
    val sagittal: List<String>,
    val gltf: String,
    var url: String? = null,
) {
    fun getSlice(plane: Plane): List<String> {
        return when (plane) {
            Plane.AXIAL -> axial
            Plane.CORONAL -> coronal
            Plane.SAGITTAL -> sagittal
        }
    }
}

typealias StatusUpdateFn = (StatusCode, String?) -> Unit

class PDicomViewModel(
    private val pDicomRepo: PDicomRepo,
) : ViewModel() {
    private val _pDicomList = MutableStateFlow(emptyMap<String, String?>())
    val pDicomList: StateFlow<Map<String, String?>> = _pDicomList.asStateFlow()

    private val _selectedPDicom = MutableStateFlow<PDicomData?>(null)
    val selectedPDicom: StateFlow<PDicomData?> = _selectedPDicom.asStateFlow()

    private val _selectedSlice = MutableStateFlow(
        mapOf(
            Plane.AXIAL to 0,
            Plane.CORONAL to 0,
            Plane.SAGITTAL to 0
        )
    )
    val selectedSlice: StateFlow<Map<Plane, Int>> = _selectedSlice.asStateFlow()

    /**
     * Hydrates the _pDicomList from disk
     */
    fun hydrate(updateStatus: StatusUpdateFn) {
        viewModelScope.launch(Dispatchers.IO) {
            updateStatus(StatusCode.PROGRESS, "Loading data on device")
            val list = pDicomRepo.loadFromDevice { msg -> updateStatus(StatusCode.PROGRESS, msg) }
            _pDicomList.update { it + list }
            updateStatus(StatusCode.SUCCESS, null)
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
                var storageLocation = _pDicomList.value[url]
                if (storageLocation == null) {
                    storageLocation =
                        pDicomRepo.download(url) { msg -> updateStatus(StatusCode.PROGRESS, msg) }
                }

                val index = pDicomRepo.load(storageLocation)
                _pDicomList.update { it + (url to storageLocation) }
                _selectedPDicom.update { index }
                updateStatus(StatusCode.SUCCESS, null)
                if (!pDicomList.value.containsKey(url)) {
                    _pDicomList.update { it + (url to null) }
                }
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
        var done = false
        if (storageLocation != null) {
            done = pDicomRepo.remove(storageLocation)
        }
        if (done) {
            _pDicomList.update { it.minus(url) }
        }
    }

    fun updateSelectedSlice(plane: Plane, value: Int) {
        _selectedSlice.update { it + (plane to value) }
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
    ERROR,
    PROGRESS,
    SUCCESS,
    NONE
}

enum class Plane {
    AXIAL, CORONAL, SAGITTAL
}

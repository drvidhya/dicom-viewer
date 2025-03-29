package com.nparashuram.dicomviewer.data

import com.nparashuram.dicomviewer.PDicomData
import kotlinx.serialization.json.Json
import okio.BufferedSource
import okio.buffer
import okio.sink
import java.io.File

class Storage internal constructor(val dir: File) {
    fun save(filename: String, data: BufferedSource) {
        val file = getFileFromFilename(filename)
        val sink = file.sink().buffer()
        sink.writeAll(data)
        sink.close()
    }

    fun save(filename: String, data: String) {
        val file = getFileFromFilename(filename)
        file.writeText(data)
    }

    fun remove(): Boolean {
        return dir.deleteRecursively()
    }

    fun readIndex(): PDicomData {
        val file = File(dir, "index.json")
        val text = file.readText()
        return Json.decodeFromString<PDicomData>(text)
    }

    private fun getFileFromFilename(filename: String): File {
        val file = File(dir, filename)
        val parentFolder = file.parentFile
        if (parentFolder != null && !parentFolder.exists()) {
            parentFolder.mkdirs()
        }
        return file
    }

}

class StorageFactory(private val storageDir: File) {
    fun get(folder: String): Storage {
        val file = File(File(storageDir, "processed-dicom"), folder)
        return Storage(file)
    }

    fun getFolders(): List<Storage> {
        val folder = File(storageDir, "processed-dicom")
        if (folder.isDirectory) {
            val folders = folder.listFiles { file -> file.isDirectory }
            return folders?.map { file -> Storage(file) } ?: emptyList()
        } else {
            return emptyList()
        }
    }
}

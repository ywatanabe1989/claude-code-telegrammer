---
description: All 30+ supported file formats with extensions, load/save types, and notes.
---

# Supported Formats

## Tabular

| Extension | Load | Save | Notes |
|-----------|------|------|-------|
| `.csv` | DataFrame | DataFrame, dict, list | Auto-detects separator |
| `.tsv` | DataFrame | — | Tab-separated |
| `.xlsx` | DataFrame | DataFrame | Requires openpyxl |
| `.xls` | DataFrame | DataFrame | Legacy Excel |
| `.xlsm` | DataFrame | — | Macro-enabled Excel |
| `.xlsb` | DataFrame | — | Binary Excel |
| `.db` | DataFrame | — | Embedded SQL database |

## Array

| Extension | Load | Save | Notes |
|-----------|------|------|-------|
| `.npy` | ndarray | ndarray | Single array |
| `.npz` | ndarray/dict | dict of ndarray | Multiple arrays |
| `.mat` | dict | dict | MATLAB (scipy) |

## Hierarchical

| Extension | Load | Save | Notes |
|-----------|------|------|-------|
| `.h5` / `.hdf5` | ndarray/dict | ndarray/dict | Requires h5py |
| `.zarr` | ndarray/dict | ndarray/dict | Requires zarr |

## Config

| Extension | Load | Save | Notes |
|-----------|------|------|-------|
| `.yaml` / `.yml` | dict | dict | YAML |
| `.json` | dict | dict | JSON |
| `.xml` | dict | — | XML |

## Serialization

| Extension | Load | Save | Notes |
|-----------|------|------|-------|
| `.pkl` / `.pickle` | any | any | Python pickle |
| `.pkl.gz` | — | any | Compressed pickle |
| `.gz` | any | — | Gzipped pickle (load) |
| `.joblib` | any | any | Joblib |

## Image

| Extension | Load | Save | Notes |
|-----------|------|------|-------|
| `.png` | ndarray | ndarray/Figure | + auto CSV export |
| `.jpg` / `.jpeg` | ndarray | ndarray/Figure | + auto CSV export |
| `.tif` / `.tiff` | ndarray | ndarray/Figure | + auto CSV export |
| `.gif` | — | Figure | Animated GIF |
| `.svg` | — | Figure | Vector |
| `.pdf` | str (text) | Figure | Text extract on load, figure on save |

## Text / Code

| Extension | Load | Save | Notes |
|-----------|------|------|-------|
| `.txt` | str | str | Plain text |
| `.md` | str | str | Markdown |
| `.log` | str | — | Log files |
| `.event` | str | — | Event files |
| `.py` | str | str | Python source |
| `.sh` | str | — | Shell scripts |
| `.tex` | str | str | LaTeX |
| `.css` | — | str | CSS |
| `.js` | — | str | JavaScript |

## Documents

| Extension | Load | Save | Notes |
|-----------|------|------|-------|
| `.docx` | str | — | Requires python-docx |
| `.html` | — | str | HTML output |

## Bibliography

| Extension | Load | Save | Notes |
|-----------|------|------|-------|
| `.bib` | list[dict] | list[dict] | BibTeX entries |

## Video

| Extension | Load | Save | Notes |
|-----------|------|------|-------|
| `.mp4` | — | frames | Frame sequence |

## ML / Deep Learning

| Extension | Load | Save | Notes |
|-----------|------|------|-------|
| `.pth` / `.pt` | state_dict | state_dict | PyTorch |
| `.cbm` | — | model | CatBoost |

## EEG / Neurophysiology

| Extension | Load | Save | Notes |
|-----------|------|------|-------|
| `.vhdr` / `.vmrk` | Raw | — | BrainVision (mne) |
| `.edf` / `.bdf` / `.gdf` | Raw | — | EDF/BDF/GDF (mne) |
| `.cnt` | Raw | — | Neuroscan (mne) |
| `.egi` | Raw | — | EGI (mne) |
| `.eeg` | Raw | — | Nihon Kohden (mne) |
| `.set` | Raw | — | EEGLAB (mne) |
| `.con` | Raw | — | Continuous data (mne) |

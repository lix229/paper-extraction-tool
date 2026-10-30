# Paper Extraction

Read papers and complete the extraction form side by side. The project includes
60 papers, a configurable form, automatic saving, and CSV export.

## Start

Install Python 3.9 or newer, then run:

```sh
git clone --single-branch --branch reviewer-extraction https://github.com/lix229/paper-extraction-tool.git
cd paper-extraction-tool
./start.sh
```

Open **http://127.0.0.1:8765** and enter your name or initials. The first start
sets up a Python environment and installs the dependencies.

On Windows, use PowerShell:

```powershell
py -3 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe server.py
```

## Review

1. Select a paper from **Papers**. Search by title, author, ID, or DOI.
2. Complete the form beside the PDF. Changes save automatically.
3. Use **Use page** and **Insert selection** to record evidence from the PDF.
4. Mark the paper **Complete** when finished, or **Needs review** for discussion.
5. Use **Export CSV** to save your results. The export dialog also offers a codebook.

Stop the server with **Ctrl+C**. Run the startup command again to continue.
Progress is saved on your computer in `data/`; back up this folder to keep your work.
Each reviewer should use their own copy of the project.

## Customize

Edit `form.yaml` and refresh the page to update the extraction form. Edit
`config.yaml` to change the port or the location where progress is saved.

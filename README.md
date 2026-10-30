# ToolsEngine

ToolsEngine is a Node.js MCP server that provides browser, desktop, and workspace tools to supported agent clients. This export contains ToolsEngine `0.2.0-alpha.4`.

**Alpha status:** ToolsEngine `0.2.0-alpha.4` is an alpha release. Interfaces and behavior may change.

The free launch distributes ToolsEngine inside TEAA. Install the combined release using the Linux or native Windows asset instructions below; this release does not provide a separate ToolsEngine archive.

## Install the free launch release

The release assets are published on the [TEAA GitHub releases](https://github.com/ToolsEnabled/teaa/releases):

- Linux x64: `teaa-0.5.0-alpha.5-linux-x64.tar.gz`
- Native Windows x64: `teaa-0.5.0-alpha.5-windows-x64.zip`
- Checksums: `SHA256SUMS`

### Linux

Download the Linux archive and `SHA256SUMS` into one directory, then run:

```sh
sha256sum -c --ignore-missing SHA256SUMS
tar -xzf teaa-0.5.0-alpha.5-linux-x64.tar.gz
cd teaa-0.5.0-alpha.5-linux-x64
./install.sh
```

### Native Windows

Download the Windows zip and `SHA256SUMS`. In PowerShell, run `Get-FileHash .\teaa-0.5.0-alpha.5-windows-x64.zip -Algorithm SHA256` and compare the result with the Windows zip line in `SHA256SUMS`. Extract the zip, open Command Prompt in the extracted `teaa-0.5.0-alpha.5-windows-x64` folder, and run:

```bat
install.cmd
```

Node.js 22.19 or newer and Python 3.11 or newer are required on both systems. Git is required for Knowledge repository operations. After installation, create or choose an absolute project folder and run:

```text
teaa setup --folder <absolute-project-folder> --actor local --no-browser --workers
teaa doctor
teaa config --server-json
```

Register the JSON from `teaa config --server-json` as a stdio MCP server in your client. See [TEAA SETUP.md](https://github.com/ToolsEnabled/teaa/blob/main/SETUP.md) for first-run details.

## Install from this source checkout

Requires Node.js 22.14 or newer. Run `npm ci`, then `npm install --global .`. Configure an MCP client to launch `toolsengine` over standard input and output. The `docs/` directory contains client and setup guidance.

This export includes source, tests, installer support, and documentation. ToolsEngine is MIT licensed; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

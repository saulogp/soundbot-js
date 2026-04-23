# SoundBot

Aplicacao para gerenciamento e reproducao de audio em canais de voz do Discord, com interface web e versao desktop (Electron).

## Requisitos

- **Node.js** 18+
- **yt-dlp** (necessario para reproducao de audio do YouTube)

### Instalando o yt-dlp (Windows)

```bash
winget install yt-dlp.yt-dlp
```

> Sem o yt-dlp, o app funciona normalmente para audios locais, mas a reproducao de links do YouTube nao estara disponivel.

## Executando

```bash
# Instalar dependencias
npm install

# Servidor standalone (porta 3000)
npm start

# Versao desktop (Electron)
npm run electron
```

## Build (Windows x64)

```bash
# NSIS installer + portable
npm run build

# Apenas installer
npm run build:nsis

# Apenas portable
npm run build:portable
```

Os executaveis serao gerados na pasta `dist/`.

## Configuracao inicial

1. Abra o app e faca login com sua conta Discord
2. Nas configuracoes do Discord, informe o **Bot Token**, **Client ID** e **Client Secret**
3. Aponte o diretorio onde os arquivos de audio estao armazenados
4. Adicione o bot ao seu servidor Discord e entre em um canal de voz

> Para obter as credenciais, crie uma aplicacao no [Discord Developer Portal](https://discord.com/developers/applications).

## Dependencias principais

| Pacote | Uso |
|---|---|
| discord.js | SDK do Discord |
| @discordjs/voice | Audio em canais de voz |
| express | Servidor web e API REST |
| multer | Upload de arquivos |
| ffmpeg-static | Codec de audio |
| opusscript | Codec Opus |
| libsodium-wrappers | Criptografia |
| electron | Versao desktop |

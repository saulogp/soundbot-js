# SoundBot — Documentacao Tecnica

## Visao Geral

SoundBot e uma aplicacao para gerenciamento e reproducao de audio em canais de voz do Discord, com interface web e versao desktop (Electron). Permite upload de arquivos de audio, links do YouTube, organizacao por categorias, thumbnails personalizadas, e reproducao via navegador e/ou bot do Discord.

## Arquitetura

```
soundbot/
  electron-main.js    # Entrada Electron (janela, tray, lifecycle)
  server.js           # Servidor Express (API REST, OAuth2, uploads, config)
  discord-bot.js      # Modulo do bot Discord (voice, audio player, yt-dlp)
  public/
    index.html         # SPA — interface completa em um unico HTML
    app.js             # Logica do frontend (vanilla JS, sem framework)
    style.css          # Estilos (dark theme, CSS variables)
  config.json          # Gerado automaticamente — persistencia de configuracao
  package.json         # Dependencias e scripts de build
```

### Fluxo de Execucao

1. **Desktop**: `electron-main.js` → seta `SOUNDBOT_CONFIG_DIR` → importa e chama `startServer()` → cria `BrowserWindow` apontando para `localhost:3000`
2. **Standalone**: `node server.js` → `startServer()` direto na porta 3000
3. O servidor auto-inicializa o bot Discord se houver token salvo no `config.json`

## Stack Tecnologica

| Camada     | Tecnologia                                    |
|------------|-----------------------------------------------|
| Runtime    | Node.js (CommonJS)                            |
| Backend    | Express 5, express-session, multer            |
| Bot        | discord.js 14, @discordjs/voice               |
| Audio      | ffmpeg-static, opusscript, libsodium-wrappers |
| Streaming  | yt-dlp (binario externo, via child_process)   |
| Desktop    | Electron 35                                   |
| Frontend   | Vanilla JS, HTML, CSS (sem framework/bundler) |

## Modulos Principais

### `server.js` — API REST

- **Autenticacao**: Discord OAuth2 (`/auth/discord`, `/auth/discord/callback`, `/auth/me`, `/auth/logout`). Sessao com `express-session`. Middleware `requireAuth` protege todas as rotas de API.
- **Config**: `loadConfig()` / `saveConfig()` — persiste em `config.json`. Suporta `SOUNDBOT_CONFIG_DIR` para Electron.
- **Categorias**: Pastas no filesystem. "Geral" e virtual (agrega tudo). CRUD via `/api/categories`.
- **Audios**: Upload via multer para `.tmp-uploads/`, depois move para pasta da categoria. Suporte a arquivos locais e entradas YouTube (metadata-only). CRUD completo via `/api/audios/*`.
- **Metadata**: `.metadata.json` por categoria — armazena thumbnail, display name, tipo (youtube), URL.
- **Seguranca**: `safePath()` previne path traversal. Validacao de extensoes no multer. Secrets do Discord nunca expostos ao frontend.

#### Rotas da API

| Metodo | Rota                       | Descricao                          |
|--------|----------------------------|------------------------------------|
| GET    | `/auth/discord`            | Inicia OAuth2                      |
| GET    | `/auth/discord/callback`   | Callback OAuth2                    |
| GET    | `/auth/me`                 | Dados do usuario autenticado       |
| POST   | `/auth/logout`             | Encerra sessao                     |
| GET    | `/api/config`              | Config (sem secrets)               |
| PUT    | `/api/config/directory`    | Altera diretorio de audios         |
| GET    | `/api/categories`          | Lista categorias                   |
| POST   | `/api/categories`          | Cria categoria                     |
| GET    | `/api/audios`              | Lista audios (por categoria)       |
| GET    | `/api/audios/search`       | Busca textual                      |
| POST   | `/api/audios`              | Upload de audio                    |
| POST   | `/api/audios/youtube`      | Salva link YouTube                 |
| PUT    | `/api/audios/thumbnail`    | Upload de thumbnail                |
| PUT    | `/api/audios/display`      | Atualiza nome de exibicao          |
| PUT    | `/api/audios/move`         | Move audio entre categorias        |
| DELETE | `/api/audios`              | Remove audio                       |
| GET    | `/api/discord/status`      | Status do bot (filtrado por guilds)|
| PUT    | `/api/discord/token`       | Configura token do bot             |
| POST   | `/api/discord/join`        | Entra em canal de voz              |
| POST   | `/api/discord/leave`       | Sai do canal de voz                |
| POST   | `/api/discord/play`        | Toca audio local no Discord        |
| POST   | `/api/discord/play-youtube`| Toca YouTube no Discord            |
| POST   | `/api/discord/play-playlist`| Toca musica/playlist YouTube (bg) |
| POST   | `/api/discord/playlist/next`| Pula para a proxima da playlist   |
| POST   | `/api/discord/playlist/prev`| Volta para a anterior da playlist |
| GET    | `/api/youtube/stream`      | Stream de audio YouTube p/ browser |
| POST   | `/api/discord/stop`        | Para reproducao no Discord         |

### `discord-bot.js` — Bot Discord

- State em Maps por `guildId`: `connections`, `players`, `ytProcesses`, `queues`
- `playPlaylist(guildId, items, { loop, shuffle })` — fila de background: toca `[{url,title}]` em sequencia, avancando no evento `Idle` do player. `loop` reinicia ao fim; `shuffle` embaralha na entrada. Playlist expandida em `server.js` via `yt-dlp --flat-playlist -J`.
- `nextTrack` / `prevTrack(guildId)` — pulo manual na fila (respeitam `loop`). O avanco automatico ocorre so no evento `Idle` para evitar pulo duplo quando um video falha.
- `init(token)` — cria Client, faz login, resolve quando ready
- `joinChannel` / `leaveChannel` — gerencia VoiceConnection com auto-reconnect
- `playAudio(guildId, filePath)` — cria AudioResource de arquivo local
- `playYouTube(guildId, url)` — spawna `yt-dlp`, pipe stdout como AudioResource
- `getStatusForUser(userGuildIds, userId)` — filtra guilds por intersecao com o usuario OAuth2
- Cleanup: `destroy()` mata processos yt-dlp, desconecta voice, destroi client

### `electron-main.js` — Desktop

- Janela unica com tray (minimiza ao fechar, double-click restaura)
- `SOUNDBOT_CONFIG_DIR` → `app.getPath('userData')` para nao escrever ao lado do .exe
- Graceful shutdown do bot no `before-quit`

### `public/app.js` — Frontend

- **State global**: `currentCategory`, `playbackMode` (local/discord/both, salvo no localStorage), `discordStatus`
- **Fluxo**: `checkAuth()` → mostra login ou app → carrega config, categorias, status Discord
- **Playback**: 3 modos — local (browser `<audio>`), discord (API call), both
- **Search**: Debounce 300ms, desabilita tabs durante busca
- **Modais**: Directory, Add Audio (file/youtube toggle), Edit Audio (display name, thumbnail, mover categoria), Discord Settings
- **Toast Player**: Barra de progresso com seek, mostra tempo

## Convencoes de Codigo

### Geral
- **Linguagem**: Portugues brasileiro para UI, mensagens de erro e nomes de categorias. Ingles para codigo (variaveis, funcoes, comentarios tecnicos).
- **Modulos**: CommonJS (`require`/`module.exports`). Sem ESM, sem TypeScript.
- **Sem framework**: Frontend vanilla. Sem React, Vue, etc. Sem bundler.
- **Sem testes automatizados**: Testes manuais.

### Backend
- Funcoes sync para filesystem (`readFileSync`, `writeFileSync`, `mkdirSync`, `readdirSync`)
- Sempre validar paths com `safePath()` antes de operacoes de arquivo
- Toda rota de API usa `requireAuth` middleware
- Respostas JSON. Erros no formato `{ error: "mensagem" }`
- Config carregada fresh em cada request (`loadConfig()` — nao cachear)

### Frontend
- DOM direto (`document.getElementById`, `document.createElement`)
- Seletores cacheados no topo: `$grid`, `$empty`, `$catNav`, `$player`
- Funcoes async para chamadas de API, sem tratamento elaborado de erro (catch silencioso em muitos casos)
- `escapeHtml()` para prevenir XSS ao renderizar nomes

### CSS
- CSS Variables em `:root` para tema (dark-first)
- Nomenclatura: BEM-like simplificado (`.card-name`, `.toast-player`, `.modal-header`)
- Breakpoints e responsividade via media queries no final do arquivo

## Dependencias Externas (runtime)

- **yt-dlp**: Binario deve estar no PATH do sistema. Usado para stream de audio do YouTube.
- **ffmpeg**: Fornecido por `ffmpeg-static` (node_module). Necessario para @discordjs/voice.

## Config (`config.json`)

```json
{
  "audioDir": "caminho/para/audios",
  "categories": ["Geral"],
  "discord": {
    "token": "bot-token",
    "clientId": "oauth-client-id",
    "clientSecret": "oauth-client-secret",
    "redirectUri": "http://localhost:3000/auth/discord/callback",
    "defaultGuildId": "...",
    "defaultChannelId": "..."
  }
}
```

- `audioDir`: Diretorio raiz onde subpastas = categorias
- `discord.token`: Token do bot (nunca exposto ao frontend)
- `discord.clientId/clientSecret`: Credenciais OAuth2
- `defaultGuildId/defaultChannelId`: Salvos automaticamente ao entrar em um canal

## Comandos

```bash
npm start           # Inicia servidor standalone (porta 3000)
npm run electron    # Inicia versao desktop
npm run build       # Build Electron (NSIS + portable) para Windows x64
```

## Notas de Desenvolvimento

- Ao adicionar novas rotas, sempre incluir `requireAuth` middleware
- Novas operacoes de filesystem devem usar `safePath()` para prevenir path traversal
- YouTube entries sao metadata-only (chave comeca com `yt_`) — nao tem arquivo fisico
- "Geral" nao e uma pasta real — e um agregador virtual de todas as categorias
- O frontend faz polling do status Discord a cada 30 segundos
- Session secret e gerado aleatoriamente a cada restart — sessoes nao persistem entre restarts do servidor

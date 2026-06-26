# Distribuição do SoundBot

Guia para gerar e distribuir o instalador do SoundBot para outras pessoas (Windows x64).

## Como funciona o modelo de distribuição

- Cada usuário roda a aplicação **localmente** (servidor Express + bot Discord embutidos no Electron).
- As credenciais do Discord (OAuth `clientId`/`clientSecret` e o **token do bot**) são embutidas no
  build via arquivo `.env` e carregadas em [electron-main.js](electron-main.js#L11) (`loadBundledEnv`).
  Assim o usuário final **não precisa configurar nada** — todos compartilham o mesmo bot.
- O login é via OAuth2 do Discord usando `http://localhost:3000/auth/discord/callback`, que já está
  registrado no app do Discord e funciona em qualquer máquina (é localhost).

> ⚠️ **Segurança (risco aceito):** como o `.env` é embutido, qualquer pessoa que instale o app
> consegue extrair o token do bot dos arquivos (`resources/.env`). Se o token vazar/for abusado,
> gere um novo no Discord Developer Portal e refaça o build. Não distribua publicamente em massa.

## Pré-requisitos para gerar o build (na máquina do desenvolvedor)

1. Node.js instalado.
2. `npm install` executado.
3. Arquivo **`.env`** presente na raiz do projeto (é gitignored — não vai pro repositório):

   ```
   SOUNDBOT_CLIENT_ID=...
   SOUNDBOT_CLIENT_SECRET=...
   SOUNDBOT_BOT_TOKEN=...
   ```

   Sem esse arquivo o `electron-builder` falha (ele está listado em `extraResources`).

## Gerar o instalador

```bash
npm run build          # gera instalador NSIS + portable em dist/
npm run build:nsis     # apenas o instalador NSIS
npm run build:portable # apenas o .exe portátil
```

Saída em `dist/`:
- `SoundBot Setup 1.0.0.exe` — instalador (cria atalhos, permite escolher pasta).
- `SoundBot 1.0.0.exe` — portátil (roda sem instalar).

## Dependências de runtime (já resolvidas — usuário não instala nada)

- **ffmpeg**: fornecido por `ffmpeg-static` e **descompactado do asar** (`asarUnpack` no
  [package.json](package.json)) para que o binário seja executável. Necessário para tocar
  qualquer áudio (local e YouTube).
- **yt-dlp**: **não** precisa estar no PATH. Na primeira vez que um recurso de YouTube é usado,
  o app baixa o `yt-dlp.exe` automaticamente para a pasta de dados do usuário
  (`%APPDATA%/SoundBot/bin/`) — ver [ytdlp.js](ytdlp.js). Se já houver `yt-dlp` no PATH, ele é usado.
  - Requer internet na primeira execução do recurso de YouTube.

## O que o usuário verá ao instalar

- **Aviso do Windows SmartScreen** ("Editor desconhecido"): o `.exe` **não é assinado**
  digitalmente. Para prosseguir, o usuário deve clicar em **"Mais informações" → "Executar assim
  mesmo"**. Isso é esperado e seguro para distribuição informal.
  - Para remover o aviso seria necessário adquirir um certificado de *code signing* (custo anual)
    e configurá-lo no `electron-builder` — fora do escopo atual.

## Dados do usuário

Tudo que o app escreve fica em `%APPDATA%/SoundBot/` (definido por `SOUNDBOT_CONFIG_DIR` em
[electron-main.js](electron-main.js#L127)) — nunca ao lado do `.exe`:
- `config.json` — configuração e credenciais efetivas.
- `audios/` — biblioteca de áudios e categorias (padrão).
- `bin/yt-dlp.exe` — binário baixado automaticamente.
- `.tmp-uploads/` — uploads temporários.

## Limitações conhecidas

- **Porta 3000 fixa**: necessária para casar com o `redirectUri` do OAuth. Se a porta estiver
  ocupada, o app mostra um diálogo de erro claro e fecha (em vez de abrir uma janela em branco).
- **Somente Windows x64**: os targets atuais (`nsis`, `portable`) são apenas para Windows x64.

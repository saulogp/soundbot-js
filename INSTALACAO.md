# Manual de Instalação — SoundBot

Guia para instalar e rodar o SoundBot. Há dois caminhos:

- **[A) Usar o app pronto](#a-usar-o-app-pronto-windows)** — instalar o `.exe` (para uso normal).
- **[B) Rodar a partir do código-fonte](#b-rodar-a-partir-do-código-fonte)** — para desenvolver ou gerar o instalador.

No fim há a **[configuração do Discord](#configuração-do-discord)**, necessária em qualquer um dos casos.

---

## A) Usar o app pronto (Windows)

### Pré-requisitos
- Windows 10/11 (64 bits).
- Não precisa instalar Node.js, ffmpeg nem yt-dlp — tudo já vem embutido. O `yt-dlp` é baixado automaticamente na primeira vez que você usa o YouTube.

### Passos
1. Abra a pasta `dist/` do projeto (gerada pelo build).
2. Escolha um dos arquivos:
   - **`SoundBot Setup x.x.x.exe`** → instalador. Executa, escolhe a pasta, cria atalho na área de trabalho e menu Iniciar.
   - **`SoundBot x.x.x.exe`** (portable) → roda direto, sem instalar.
3. Abra o **SoundBot**. A janela abre em `http://localhost:3000` e um ícone aparece na bandeja (tray).
4. Fechar a janela **minimiza** para a bandeja. Para sair de verdade, clique com o botão direito no ícone da bandeja → **Sair**.

> As credenciais do Discord já vêm embutidas no build (arquivo `.env`). Se for um build seu, veja a seção [Configuração do Discord](#configuração-do-discord).

---

## B) Rodar a partir do código-fonte

### Pré-requisitos
- **Node.js 18+** (recomendado LTS) — inclui o `npm`. Baixe em <https://nodejs.org>.
- **Git** (opcional, para clonar).

ffmpeg vem do pacote `ffmpeg-static` (instalado pelo npm). O `yt-dlp` é baixado automaticamente na primeira execução.

### 1. Obter o código
```bash
git clone <url-do-repositorio> soundbot
cd soundbot
```
(ou apenas abra a pasta do projeto que você já tem).

### 2. Instalar dependências
```bash
npm install
```

### 3. Configurar credenciais do Discord
Crie um arquivo **`.env`** na raiz do projeto com:
```
SOUNDBOT_CLIENT_ID=seu_client_id
SOUNDBOT_CLIENT_SECRET=seu_client_secret
SOUNDBOT_BOT_TOKEN=seu_bot_token
```
Veja como obter esses valores em [Configuração do Discord](#configuração-do-discord).

> ⚠️ O `.env` é lido automaticamente apenas na versão **desktop** (`npm run electron`). Na versão **standalone** (`npm start`), defina as variáveis no ambiente antes de iniciar, **ou** configure o token depois pela própria interface (engrenagem → Discord).
>
> PowerShell (standalone):
> ```powershell
> $env:SOUNDBOT_CLIENT_ID="..."; $env:SOUNDBOT_CLIENT_SECRET="..."; $env:SOUNDBOT_BOT_TOKEN="..."; npm start
> ```

### 4. Rodar
```bash
npm start          # servidor web em http://localhost:3000
npm run electron   # versão desktop (janela + bandeja)
```
Abra o navegador em **http://localhost:3000** (no modo `npm start`).

### 5. (Opcional) Gerar o instalador Windows
```bash
npm run build           # gera instalador NSIS + portable em dist/
npm run build:portable  # só o portable
npm run build:nsis      # só o instalador
```
Os arquivos saem na pasta `dist/`.

---

## Configuração do Discord

Você precisa de uma aplicação no Discord para o login (OAuth2) e o bot funcionarem.

1. Acesse o **Discord Developer Portal**: <https://discord.com/developers/applications> → **New Application**.
2. **OAuth2** (login web):
   - Copie o **Client ID** → `SOUNDBOT_CLIENT_ID`.
   - Em **Client Secret**, clique em *Reset Secret* e copie → `SOUNDBOT_CLIENT_SECRET`.
   - Em **Redirects**, adicione exatamente:
     ```
     http://localhost:3000/auth/discord/callback
     ```
3. **Bot** (reprodução de áudio):
   - Aba **Bot** → *Reset Token* → copie → `SOUNDBOT_BOT_TOKEN`.
   - Ative os **Privileged Gateway Intents** necessários (Server Members / Presence, se aplicável).
4. **Convidar o bot** ao seu servidor:
   - Aba **OAuth2 → URL Generator**, marque os escopos `bot` e `applications.commands`, e as permissões de voz (*Connect*, *Speak*).
   - Abra a URL gerada e adicione o bot ao servidor.

Com os três valores no `.env` (ou nas variáveis de ambiente), inicie o app e faça login com sua conta Discord.

---

## Primeiro uso

1. Abra o SoundBot e clique em **Entrar com Discord**.
2. Defina a pasta de áudios (modal de diretório) — cada subpasta vira uma categoria. "Geral" agrega tudo.
3. Adicione áudios por **upload** de arquivo ou **link do YouTube**.
4. Escolha o modo de reprodução: **local** (toca no navegador), **discord** (toca no canal de voz) ou **ambos**.
5. Para tocar no Discord: configure/conecte o bot (engrenagem → Discord), entre num canal de voz e dê play.

---

## Solução de problemas

| Problema | Causa / solução |
|----------|-----------------|
| `A porta 3000 já está em uso` | Outro programa (ou outra instância do SoundBot) está usando a porta. Feche-o e abra novamente. |
| Login do Discord não volta / erro de redirect | O **Redirect URI** no Developer Portal precisa ser exatamente `http://localhost:3000/auth/discord/callback`. |
| YouTube não toca | Na primeira vez o `yt-dlp` é baixado automaticamente — precisa de internet. Verifique sua conexão e tente de novo. |
| Bot não entra no canal | Confirme que o bot foi convidado ao servidor e tem permissões de **Connect** e **Speak**. |
| Áudio sem som no Discord | ffmpeg vem do `ffmpeg-static`; rode `npm install` novamente se estiver rodando do código-fonte. |

---

## Resumo rápido

**Usuário final:** abrir `dist/SoundBot Setup x.x.x.exe` → instalar → abrir → login Discord.

**Desenvolvedor:**
```bash
npm install
# criar .env com as credenciais do Discord
npm run electron   # ou: npm start
```

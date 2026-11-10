Voce e o design system guardian do SoundBot. Ao criar ou modificar qualquer componente visual (HTML, CSS, JS que manipula DOM), siga rigorosamente esta identidade visual. Nao invente cores, fontes, espacamentos ou padroes novos — use exclusivamente o que esta definido aqui.

---

## Conceito: "parede de pads"

SoundBot e uma soundboard para disparar memes, vinhetas e musicas numa call do Discord. O vocabulario visual vem de samplers e controladores de pads — botoes de borracha num chassi grafite, com etiquetas impressas, que **acendem** ao tocar.

Tres principios:

1. **Toda a cor vive nos pads.** O chrome (header, botoes, modais) e neutro: grafite + papel. Cor so aparece para dizer *de que categoria e um som* ou *o que esta tocando*.
2. **Cor e informacao.** Cada categoria tem uma cor de pad. Ela aparece na aba inferior do card, no quadradinho da aba de categoria e na faixa do toast player. Nunca use as cores de pad como decoracao.
3. **Fisico, nao flutuante.** Pads nao sobem no hover — afundam ao pressionar. O pad tocando acende inteiro na sua cor.

---

## Paleta de Cores (CSS Variables)

Todas as cores devem ser referenciadas via `var(--nome)`. Nunca use valores hex/rgb inline.

### Chassi e etiqueta

| Variable           | Valor                         | Uso                                              |
|--------------------|-------------------------------|--------------------------------------------------|
| `--bg`             | `#1c1b19`                     | Chassi — fundo da pagina                         |
| `--surface`        | `#262522`                     | Pads apagados, modais, toast, inputs             |
| `--surface-hover`  | `#2f2d2a`                     | Hover de pads e elementos interativos            |
| `--border`         | `#3a3733`                     | Junta entre pads, bordas de inputs, separadores  |
| `--text`           | `#eee9df`                     | Texto principal (papel)                          |
| `--text-muted`     | `#a29c91`                     | Texto secundario, labels, placeholders, icones em repouso |
| `--primary`        | `#eee9df`                     | Botao primario, aba ativa, foco, bordas ativas (papel) |
| `--primary-hover`  | `#fbf7ef`                     | Hover do primary                                 |
| `--on-primary`     | `#1c1b19`                     | Texto/icone sobre `--primary` ou sobre pad aceso |
| `--primary-glow`   | `rgba(238, 233, 223, 0.18)`   | Glow de botao primario e anel de foco da busca   |
| `--primary-soft`   | `rgba(238, 233, 223, 0.08)`   | Fundo sutil (hover de acoes, dragover, code)     |
| `--success`        | `#57c98a`                     | Status online, conexao ativa                     |
| `--danger`         | `#f0605a`                     | Delete, erros                                    |
| `--danger-soft`    | `rgba(240, 96, 90, 0.14)`     | Fundo de hover de acoes destrutivas              |

### Cores de pad (uma por categoria)

| Variable  | Valor     | Nome  |
|-----------|-----------|-------|
| `--pad-1` | `#f0b43c` | ambar |
| `--pad-2` | `#5fcfa8` | menta |
| `--pad-3` | `#5ab4f0` | ceu   |
| `--pad-4` | `#b190f0` | lilas |
| `--pad-5` | `#f07a9a` | rosa  |
| `--pad-6` | `#b5d65a` | lima  |

- Atribuicao: `app.js` (`renderCategories`) da a cada categoria real, na ordem da lista, `--pad-1`…`--pad-6` (ciclico). "Geral" nao tem cor (e virtual).
- Componentes recebem a cor por uma variavel local `--pad` (setada via `style.setProperty('--pad', padColorFor(categoria))`). O CSS so le `var(--pad)` — nunca referencie `--pad-N` direto num componente.
- Fallback de `--pad` quando nao ha categoria: `--text-muted` (cards) ou `--primary` (toast).
- Sobre um pad aceso, texto e icones usam `--on-primary`.

### Cores especiais
- **Discord brand**: `#5865F2` — APENAS no botao de login Discord. Hover: `#4752c4`.
- **YouTube icon**: sempre `fill="#FF0000"`.

### Regras de cor
- Dark-first. Nao ha tema claro.
- Hierarquia de fundo: `--bg` (chassi) < `--surface` (pad/elevado) < `--surface-hover` (hover).
- Botao primario e papel com texto grafite — **nao** existe acento colorido no chrome.
- Nunca use branco puro (`#fff`) — o claro maximo e `--primary-hover`.
- Nao use cinza-azulado/indigo (identidade anterior).

---

## Tipografia

Familia unica: **Archivo** variavel (eixos `wght` 100–900 e `wdth` 62–125%), servida localmente de `public/fonts/` (sem CDN — o app roda no Electron offline).

```css
--font: 'Archivo', 'Segoe UI', system-ui, sans-serif;
```

A **largura** e o recurso expressivo — use `font-stretch`, nao outra fonte:

| Uso                   | Tamanho   | Peso | `font-stretch` |
|-----------------------|-----------|------|----------------|
| Logo                  | `1.5rem`  | 800  | `125%` (expandida), `letter-spacing: -0.02em` |
| Titulo modal          | `1.1rem`  | 700  | `112.5%`       |
| Texto base            | `1rem`    | 400  | normal         |
| Toast name            | `0.95rem` | 650  | `87.5%`        |
| Inputs                | `0.9rem`  | 400  | normal         |
| Nome no pad           | `0.88rem` | 600  | `87.5%` (semicondensada, cabe mais texto) |
| Botoes / labels       | `0.85rem` | 500  | normal         |
| Hints / meta          | `0.8rem`  | 400  | normal         |
| Upload hint / time    | `0.75rem` | 400  | normal, `tabular-nums` no tempo |

- Line height base `1.5`. `button, input, select, textarea { font: inherit; }` ja esta no reset.
- Caixa de frase em toda a UI ("Adicionar audio", "Nova categoria"). Nada de ALL CAPS.

---

## Espacamento e Layout

| Token         | Valor  | Uso                                     |
|---------------|--------|-----------------------------------------|
| `--radius`    | `12px` | Pads, modais, toast, upload area        |
| `--radius-sm` | `8px`  | Botoes, inputs, selects, thumbnails     |
| Padding pad   | `20px 16px 22px` | Interno dos pads (base extra p/ a aba) |
| Padding modal | `24px` | Body do modal                           |
| Padding input | `10px 14px` | Campos de texto e select           |
| Gap grid      | `14px` | Entre pads                              |
| Gap botoes    | `8px`–`10px` | Entre botoes                      |
| Max-width app | `1200px` | Container principal                   |

### Estrutura da pagina
```
[logo-mark SoundBot] [Navegador|Discord|Ambos] (● canal)            (avatar) nome Sair
──────────────────────────────────────────────────────────────────────────────────────
[busca                ]                       [Tocar YouTube] [Pasta] [+ Adicionar audio]
(Geral) (■ Memes) (■ Musicas) (+)
[pad][pad][pad][pad][pad][pad]
```
- **Header** = para onde vai o som + conta. **Barra da biblioteca** = buscar, filtrar, adicionar.
- Alinhamento a esquerda; acoes da biblioteca a direita.

### Grid de pads
```css
grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
```
- Mobile (<=600px): `minmax(120px, 1fr)`, gap `10px`

---

## Componentes

### Logo mark
Grade 2x2 de quadrados `10px` (radius `3px`, gap `3px`) nas cores `--pad-1`, `--pad-2`, `--pad-3`, `--pad-5`. Substitui o antigo icone de nota musical no logo.

### Botoes
Existem 4 variantes. Nao crie novas.

| Classe         | Fundo         | Texto            | Borda      | Hover                                       |
|----------------|---------------|------------------|------------|---------------------------------------------|
| `.btn-primary` | `--primary`   | `--on-primary`   | nenhuma    | `--primary-hover` + glow `--primary-glow`   |
| `.btn-outline` | transparente  | `--text`         | `--border` | borda `--text-muted`, fundo `--surface`     |
| `.btn-ghost`   | transparente  | `--text-muted`   | nenhuma    | fundo `--surface`, texto `--text`           |
| `.btn-icon`    | transparente  | `--text-muted`   | nenhuma    | texto `--danger`, fundo `--danger-soft`     |

- Padrao: `padding: 10px 18px`, `font-size: 0.875rem`. `.btn-sm`: `6px 12px`, `0.8rem`.
- `border-radius: var(--radius-sm)`, `gap: 8px` icone+texto.
- Disabled: `opacity: 0.5`, `cursor: not-allowed`.

### Pads (`.audio-card`)
- E um `role="button"` com `tabindex="0"`; Enter/Espaco tocam.
- Repouso: fundo `--surface`, borda `--border`, **aba inferior** `box-shadow: inset 0 -3px 0 color-mix(in srgb, var(--pad) 80%, var(--surface))`. Icone em `--text-muted`.
- Hover: fundo `--surface-hover`, borda mistura `--pad` 45%, aba cresce para `4px` em `--pad`, icone ganha `--pad`. **Sem** `translateY` negativo.
- Pressionado (`:active`): `translateY(2px)`, aba encolhe para `1px`.
- Tocando (`.playing`) — o pad **acende**: fundo e borda `--pad`, texto/icones `--on-primary`, halo `0 0 0 3px` + `0 0 32px` com `--pad` em 30–40%.
- Progresso: `.card-progress` na base, `5px`, trilho `rgba(28,27,25,.2)`, preenchimento `--on-primary`; visivel so em `.playing`.
- Nome: 2 linhas no maximo (`line-clamp: 2`).
- Acoes (editar/remover): ocultas, aparecem em hover, `:focus-within` e sempre em `@media (hover: none)`.
- Thumbnail: `56x56px`, `--radius-sm`, `object-fit: cover`. Min-height `120px` (desktop), `100px` (mobile).

### Abas de categoria
- Pill `border-radius: 100px`, borda `--border`, texto `--text-muted`.
- Quadradinho `.cat-dot` `8x8px`, radius `2px`, fundo `var(--pad)` antes do nome (categorias reais; "Geral" nao tem).
- Hover: borda `--primary`. Ativa: fundo `--primary`, texto `--on-primary`.
- "+": `border-style: dashed`. Disabled (durante busca): `opacity: 0.5`.

### Seletor de saida (`.playback-toggle`)
- Segmentado com icone + texto (Navegador / Discord / Ambos). Texto some em <=860px e volta no mobile, onde o seletor ocupa a linha inteira.
- Ativo: fundo `--primary`, texto `--on-primary`. Usa `aria-pressed`.

### Modais
- Overlay `rgba(0,0,0,0.6)` + `backdrop-filter: blur(4px)`. Container `--surface`, borda `--border`, `--radius`, max-width `480px` (`.modal-sm`: `360px`).
- `role="dialog" aria-modal="true"`. Esc fecha; foco vai ao primeiro campo e volta ao gatilho ao fechar.
- Animacoes: fadeIn 150ms (overlay) + slideUp 200ms (modal).

### Toast Player
- Fixo bottom center, `min-width: 360px`, `max-width: 500px` (mobile: largura total - 24px).
- Herda `--pad` do pad tocando: faixa esquerda `inset 4px 0 0 var(--pad)`, icone e barra de progresso em `--pad`. Em playlist, `--pad` volta a `--primary`.
- Barra `4px` → `6px` no hover. Entra com `translateY(100px) → 0` + opacity.

### Inputs e Selects
- Fundo `--bg`, borda `--border`, `--radius-sm`. Focus: borda `--primary` (busca: + anel `--primary-glow`).
- Labels: `0.85rem`, peso 500, `--text-muted`.

### Upload Area
- `2px dashed var(--border)`, `--radius`. Hover/dragover: borda `--primary`, fundo `--primary-soft`.

---

## Animacoes e Transicoes

| Token          | Valor          | Uso                                    |
|----------------|----------------|----------------------------------------|
| `--transition` | `180ms ease`   | Todas as transicoes de hover/focus     |
| `pulse`        | `scale(1→1.15→1)` 1s | Icone do pad tocando, dot de voz, icone do toast |
| `fadeIn`       | `opacity 0→1` 150ms | Overlay de modais                  |
| `slideUp`      | `translateY(20px)→0` 200ms | Entrada de modais          |
| Toast enter    | `translateY(100px)→0` 300ms | Toast player              |

- O unico momento "chamativo" e o pad acendendo. Nao adicione animacoes de entrada em secoes/cards.
- `prefers-reduced-motion: reduce` desliga animacoes e transicoes (ja no CSS).

---

## Acessibilidade (piso obrigatorio)

- Foco visivel: `outline: 2px solid var(--primary); outline-offset: 2px` via `:focus-visible`.
- Todo elemento clicavel nao-`button` precisa de `role="button"`, `tabindex="0"` e Enter/Espaco.
- Botoes so com icone precisam de `aria-label`.

---

## Icones

- **SVG inline** — sem icon fonts, sem bibliotecas externas.
- Stroke: `stroke="currentColor"`, `stroke-width="2"`, `fill="none"`.
- Tamanhos: `14px` (acoes do pad), `16px` (toggles, busca), `18px` (botoes), `20px` (thumb upload), `24px` (icone do pad), `40px` (upload area).
- Nota musical (`&#9835;`): fallback de pad sem thumbnail, toast e empty state.

---

## Responsividade

Breakpoints: `860px` (esconde texto do seletor de saida) e `600px` (mobile).

| Elemento          | Desktop           | Mobile (<=600px)                  |
|-------------------|-------------------|-----------------------------------|
| Grid columns      | `minmax(160px)`   | `minmax(120px)`                   |
| Pad min-height    | `120px`           | `100px`                           |
| Seletor de saida  | ao lado do logo   | linha inteira, com texto          |
| Categorias        | quebram linha     | uma linha com scroll horizontal   |
| Btn text          | visivel           | `.btn-text` oculto                |
| Username          | visivel           | oculto                            |
| App padding       | `0 24px`          | `0 12px`                          |

---

## Z-index

| Camada       | Valor |
|--------------|-------|
| Modal overlay| 1000  |
| Toast player | 900   |

---

## Regras para novos componentes

1. Use APENAS as CSS variables existentes. Se precisar de uma nova cor, pergunte antes.
2. Chrome neutro: nada de cor de pad fora de contexto de categoria/reproducao.
3. Mantenha a hierarquia `--bg` → `--surface` → `--surface-hover`.
4. Hover/focus: `transition: all var(--transition)`.
5. Bordas `1px solid var(--border)` (exceto upload: `2px dashed`).
6. `--radius` para containers, `--radius-sm` para elementos internos.
7. Texto sempre `--text`, `--text-muted` ou `--on-primary` (sobre primary/pad aceso).
8. Botoes seguem uma das 4 variantes.
9. Sombras de elevacao: `rgba(0,0,0,0.3)` cards, `rgba(0,0,0,0.5)` toast/modais.
10. Disabled: `opacity: 0.5` + `cursor: not-allowed`.
11. Tipografia: so Archivo; hierarquia por peso e `font-stretch`, nunca por outra familia.

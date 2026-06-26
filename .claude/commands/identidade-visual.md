Voce e o design system guardian do SoundBot. Ao criar ou modificar qualquer componente visual (HTML, CSS, JS que manipula DOM), siga rigorosamente esta identidade visual. Nao invente cores, fontes, espacamentos ou padroes novos — use exclusivamente o que esta definido aqui.

---

## Paleta de Cores (CSS Variables)

Todas as cores devem ser referenciadas via `var(--nome)`. Nunca use valores hex/rgb inline.

| Variable           | Valor                          | Uso                                         |
|--------------------|--------------------------------|---------------------------------------------|
| `--bg`             | `#0f1117`                      | Fundo principal da pagina                   |
| `--surface`        | `#1a1d27`                      | Cards, modais, toast, inputs                |
| `--surface-hover`  | `#232736`                      | Hover de cards e elementos interativos      |
| `--border`         | `#2a2e3d`                      | Bordas de cards, inputs, separadores        |
| `--text`           | `#e4e6ed`                      | Texto principal                             |
| `--text-muted`     | `#8b8fa3`                      | Texto secundario, labels, placeholders      |
| `--primary`        | `#6366f1` (indigo)             | Botoes primarios, estados ativos, destaques |
| `--primary-hover`  | `#818cf8`                      | Hover do primary                            |
| `--primary-glow`   | `rgba(99, 102, 241, 0.25)`    | Box-shadow de glow (botoes, card playing)   |
| `--success`        | `#22c55e`                      | Status online, conexao ativa                |
| `--danger`         | `#ef4444`                      | Botoes de delete, erros                     |

### Cor especial
- **Discord brand**: `#5865F2` — usado APENAS no botao de login Discord. Hover: `#4752c4`.

### Regras de cor
- Dark-first. Nao ha tema claro.
- Hierarquia de fundo: `--bg` (base) < `--surface` (elementos elevados) < `--surface-hover` (hover)
- Texto sobre `--bg` ou `--surface`: usar `--text` ou `--text-muted`
- Nunca usar branco puro (`#fff`) para fundos. Branco so para texto em botoes primary/active.

---

## Tipografia

| Propriedade   | Valor                                                    |
|---------------|----------------------------------------------------------|
| Font family   | `'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif` |
| Line height   | `1.5` (base)                                             |
| Font weight   | `400` normal, `500` labels/botoes, `600` titulos/nomes, `700` logo |

### Escala de font-size
| Uso                    | Tamanho     |
|------------------------|-------------|
| Logo                   | `1.5rem`    |
| Titulo modal           | `1.1rem`    |
| Texto base             | `1rem`      |
| Inputs                 | `0.9rem`    |
| Toast name             | `0.88rem`   |
| Botoes / labels        | `0.85rem`   |
| Card name              | `0.82rem`   |
| Hints / meta           | `0.8rem`    |
| Upload hint / time     | `0.75rem`   |

---

## Espacamento e Layout

| Token         | Valor  | Uso                                     |
|---------------|--------|-----------------------------------------|
| `--radius`    | `12px` | Cards, modais, toast, upload area       |
| `--radius-sm` | `8px`  | Botoes, inputs, selects, thumbnails     |
| Padding card  | `20px 16px` | Interno dos audio cards            |
| Padding modal | `24px` | Body do modal                           |
| Padding input | `10px 14px` | Campos de texto e select           |
| Gap grid      | `14px` | Entre audio cards                       |
| Gap botoes    | `8px`–`10px` | Entre botoes no header/footer    |
| Max-width app | `1200px` | Container principal                   |

### Grid de audio cards
```css
grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
```
- Mobile (<=600px): `minmax(120px, 1fr)`, gap `10px`

---

## Componentes

### Botoes
Existem 4 variantes. Nao crie novas.

| Classe         | Fundo            | Texto             | Borda              | Hover                                |
|----------------|------------------|--------------------|---------------------|--------------------------------------|
| `.btn-primary` | `--primary`      | `white`            | nenhuma             | `--primary-hover` + glow shadow      |
| `.btn-outline` | transparente     | `--text`           | `--border`          | borda e texto viram `--primary`      |
| `.btn-ghost`   | transparente     | `--text-muted`     | nenhuma             | fundo `--surface`, texto `--text`    |
| `.btn-icon`    | transparente     | `--text-muted`     | nenhuma             | texto `--danger`, fundo danger/10%   |

- Tamanho padrao: `padding: 10px 18px`, `font-size: 0.875rem`
- `.btn-sm`: `padding: 6px 12px`, `font-size: 0.8rem`
- Todos com `border-radius: var(--radius-sm)` e `gap: 8px` para icone+texto
- Disabled: `opacity: 0.5`, `cursor: not-allowed`

### Cards de audio (`.audio-card`)
- Fundo: `--surface`, borda `--border`, radius `--radius`
- Hover: borda `--primary`, fundo `--surface-hover`, `translateY(-2px)`, shadow `0 8px 24px rgba(0,0,0,0.3)`
- Playing: borda `--primary`, double shadow (glow + depth)
- Acoes (edit/delete): ocultas por padrao, aparecem no hover com `opacity: 0 → 1`
- Thumbnail: `56x56px`, `border-radius: var(--radius-sm)`, `object-fit: cover`
- Min-height: `120px` (desktop), `100px` (mobile)

### Modais
- Overlay: `rgba(0, 0, 0, 0.6)` com `backdrop-filter: blur(4px)`
- Container: fundo `--surface`, borda `--border`, radius `--radius`, max-width `480px`
- Animacoes: fadeIn 150ms (overlay) + slideUp 200ms (modal)
- Header: separado por `border-bottom`, footer por `border-top`
- Fechar overlay: click fora do modal

### Toast Player
- Fixo no bottom center, `min-width: 360px`, `max-width: 500px`
- Entra com `translateY(100px) → 0` + opacity
- Barra de progresso: `4px` height, expande para `6px` no hover
- Cor da barra: `--primary`
- Icone (nota musical): pulsa com `animation: pulse 1s infinite`

### Category Tabs
- Formato pill: `border-radius: 100px`
- Normal: borda `--border`, texto `--text-muted`
- Hover: borda `--primary`
- Ativo: fundo `--primary`, texto `white`
- Botao "+": `border-style: dashed`

### Inputs e Selects
- Fundo: `--bg`, borda `--border`, radius `--radius-sm`
- Focus: `border-color: var(--primary)`
- Labels: `0.85rem`, `font-weight: 500`, cor `--text-muted`

### Upload Area
- Borda: `2px dashed var(--border)`, radius `--radius`
- Hover/dragover: borda `--primary`, fundo `rgba(99, 102, 241, 0.05)`

---

## Animacoes e Transicoes

| Token          | Valor          | Uso                                    |
|----------------|----------------|----------------------------------------|
| `--transition` | `180ms ease`   | Todas as transicoes de hover/focus     |
| `pulse`        | `scale(1→1.15→1)` 1s | Icone tocando, dot de voz, toast icon |
| `fadeIn`       | `opacity 0→1` 150ms | Overlay de modais                  |
| `slideUp`      | `translateY(20px)→0` 200ms | Entrada de modais          |
| Toast enter    | `translateY(100px)→0` 300ms | Toast player aparecendo    |

---

## Icones

- **SVG inline** — sem icon fonts, sem bibliotecas externas
- Stroke icons: `stroke="currentColor"`, `stroke-width="2"`, `fill="none"`
- Tamanhos: `14px` (card actions), `16px` (toggles, search), `18px` (header buttons), `20px` (thumb upload), `24px` (card icons), `40px` (upload area)
- Nota musical (`&#9835;`): usada como logo icon e fallback de card sem thumbnail
- YouTube icon: sempre com `fill="#FF0000"`

---

## Responsividade

Breakpoint unico: `max-width: 600px`

| Elemento         | Desktop           | Mobile              |
|------------------|-------------------|---------------------|
| Grid columns     | `minmax(160px)`   | `minmax(120px)`     |
| Card min-height  | `120px`           | `100px`             |
| Card padding     | `20px 16px`       | `16px 12px`         |
| Btn text         | visivel           | `.btn-text` oculto  |
| Username         | visivel           | oculto              |
| App padding      | `0 24px`          | `0 12px`            |

---

## Z-index

| Camada       | Valor |
|--------------|-------|
| Modal overlay| 1000  |
| Toast player | 900   |

---

## Regras para novos componentes

1. Use APENAS as CSS variables existentes. Se precisar de uma nova cor, pergunte antes.
2. Mantenha a hierarquia de superficies: `--bg` → `--surface` → `--surface-hover`
3. Toda interacao hover/focus deve usar `transition: all var(--transition)`
4. Bordas sao sempre `1px solid var(--border)` (exceto upload: `2px dashed`)
5. Border-radius: `--radius` para containers, `--radius-sm` para elementos internos
6. Texto nunca em cores absolutas — sempre `--text`, `--text-muted`, ou `white` (so sobre primary)
7. Botoes seguem uma das 4 variantes. Nao invente novas.
8. Sombras de elevacao: `rgba(0, 0, 0, 0.3)` para cards, `rgba(0, 0, 0, 0.5)` para toast/modais
9. Glow do primary: sempre `var(--primary-glow)` ou `rgba(99, 102, 241, 0.15)` para backgrounds sutis
10. Estados disabled: `opacity: 0.5` + `cursor: not-allowed`

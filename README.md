# pi-lazy-context

Extensão para o Pi Coding Agent que reduz automaticamente o contexto enviado ao modelo e alterna o conjunto de tools conforme a intenção do prompt.

## Recursos

- Ativa apenas tools de leitura em prompts sem intenção de escrita.
- Preserva resultados recentes e poda resultados antigos e grandes apenas no contexto enviado ao modelo.
- Converte JSON grande e seguro para TOON quando há economia real.
- Pode encurtar descrições de tools com opt-in explícito (`trimToolDescriptions`).
- Mantém a sessão persistida intacta.

## Instalação

```bash
pi install ./pi-lazy-context
# ou, após publicação:
pi install npm:pi-lazy-context
```

## Configuração

Crie `.pi/lazy-context.json` no projeto para sobrescrever os padrões. A extensão funciona com os padrões mesmo sem arquivo de configuração.

```json
{
  "enabled": true,
  "lazyTools": true,
  "lazyContext": true,
  "fullTools": ["read", "bash", "edit", "write"],
  "readOnlyTools": ["read", "bash"],
  "protectRecentMessages": 12,
  "toolResultTruncateChars": 4000,
  "toolResultTruncateKeepChars": 800,
  "trimToolDescriptions": false,
  "toolDescriptionMaxChars": 300,
  "toonContext": true,
  "toonMinChars": 1200,
  "toonMinSavingsRatio": 0.10
}
```

## Comandos

- `/lazy status`
- `/lazy on` e `/lazy off`
- `/lazy stats`
- `/lazy trim-specs on` e `/lazy trim-specs off`

## Requisitos

- Pi Coding Agent >= 0.84
- Node.js >= 22
- TOON é opcional; sem o CLI, a conversão é ignorada.

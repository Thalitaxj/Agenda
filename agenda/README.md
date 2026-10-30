# AgendaAí — Agendamento Online pelo WhatsApp

SaaS de agendamento para profissionais autônomos (barbeiros, manicures, tatuadores, cabeleireiros etc.).
O profissional organiza sua agenda e compartilha um link público; o cliente escolhe serviço, data e horário
livre e confirma o pedido via WhatsApp (`wa.me`).

> **Importante:** uma mensagem enviada pelo WhatsApp é apenas um *pedido* de agendamento. A confirmação
> real acontece quando o profissional muda o status para **confirmado** no painel.

## Stack

- **Frontend:** HTML5 + CSS3 + JavaScript (vanilla, mobile-first). Supabase JS via CDN.
- **Backend:** Supabase (PostgreSQL + Auth + RLS + Edge Functions).
- **Validação de conflito de horário:** feita no servidor (Edge Function + constraint no banco).

## Estrutura de pastas

```
.
├── public/                 # Frontend estático
│   ├── index.html          # Landing + login/cadastro
│   ├── app.html            # Painel do profissional (SPA)
│   ├── agendar.html        # Página pública de agendamento
│   ├── img/                # Ilustrações SVG locais (funcionam offline)
│   ├── css/
│   │   └── styles.css
│   └── js/
│       ├── config.js       # URL e anon key do Supabase (chaves PÚBLICAS)
│       ├── supabaseClient.js
│       ├── auth.js
│       ├── app.js          # Lógica do painel
│       ├── booking.js      # Lógica da página pública
│       └── lib/
│           ├── ui.js       # Helpers de UI (toasts, loading, modais)
│           └── scheduling.js # Cálculo de slots livres (compartilhado)
├── supabase/
│   ├── migrations/
│   │   └── 0001_init.sql    # Schema + RLS + funções + constraints
│   ├── seed.sql             # Dados de exemplo (opcional)
│   └── functions/
│       └── create-booking/  # Edge Function: cria agendamento com validação
│           └── index.ts
├── .env.example
└── SETUP.md                # Passo a passo de configuração do Supabase
```

## Começando

### Modo LOCAL (sem Supabase, sem internet) — padrão atual

O app vem com `LOCAL_MODE = true` em `public/js/config.js`. Nesse modo há um
"backend local" (`public/js/localBackend.js`) que guarda tudo no `localStorage`
do navegador e reproduz as mesmas regras de servidor (validação de janela de
atendimento, bloqueios e prevenção de conflito de horário).

1. Sirva a pasta `public/` com qualquer servidor estático:
   - `npx serve public` (ou, no Windows com política de scripts restritiva: `cmd /c "npx.cmd --yes serve public -l 3000"`)
   - ou `python -m http.server 3000 --directory public`
2. Abra `http://localhost:3000`, crie uma conta e use o painel.
3. Para testar a página pública, use o link que aparece no painel (botão **Meu link** / aba **Perfil**):
   `http://localhost:3000/agendar.html?slug=SEU-SLUG`.

> No modo local os dados ficam **só naquele navegador** (não há multiusuário
> entre máquinas). É ideal para testar o fluxo e a interface. Para apagar tudo
> e recomeçar, limpe o `localStorage` do site (DevTools → Application → Local Storage)
> ou remova a chave `agendazap_db_v1`.

### Modo Supabase (nuvem, produção)

1. Em `public/js/config.js`, troque para `LOCAL_MODE = false`.
2. Leia **[SETUP.md](./SETUP.md)** e crie seu projeto no Supabase.
3. Rode `supabase/migrations/0001_init.sql` (o `seed.sql` é opcional).
4. Preencha `SUPABASE_URL` e `SUPABASE_ANON_KEY` em `config.js`.
5. Faça deploy da Edge Function `create-booking`.
6. Sirva a pasta `public/`.

## Recursos

Todos os recursos estão disponíveis sem limites: serviços ilimitados, agenda
completa (dia/semana/mês), cadastro e histórico de clientes, bloqueios/folgas,
link público personalizado e imagens de perfil, capa e serviços.

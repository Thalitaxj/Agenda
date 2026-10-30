# Migrar o AgendaAí para o Supabase — passo a passo

Guia completo para sair do modo local (localStorage) e colocar o AgendaAí num
backend real, onde clientes conseguem agendar e confirmar de qualquer celular.

> Você vai precisar de: uma conta no Supabase (grátis) e, no fim, um lugar para
> hospedar a pasta `public/` (Netlify ou Vercel — grátis). Nada disso tem custo
> para começar.

---

## Etapa 1 — Criar o projeto no Supabase

1. Acesse https://supabase.com e crie uma conta (pode usar login do GitHub/Google).
2. Clique em **New project**.
3. Preencha:
   - **Name:** agendaai (ou o que preferir)
   - **Database Password:** crie uma senha forte e **guarde** (você quase não vai usar, mas anote).
   - **Region:** escolha **South America (São Paulo)** para menor latência no Brasil.
4. Clique em **Create new project** e aguarde ~2 minutos até provisionar.

## Etapa 2 — Pegar as chaves

No projeto, vá em **Project Settings** (engrenagem) → **API**. Anote:

- **Project URL** — ex: `https://xxxxxxxx.supabase.co`  (isto é o `SUPABASE_URL`)
- **anon public** (em "Project API keys") — chave pública, pode ir no navegador (`SUPABASE_ANON_KEY`)
- **service_role** — chave **SECRETA**. **NÃO** coloque no frontend. Só é usada pelas Edge Functions, e o Supabase a injeta sozinho. Não precisa copiá-la para lugar nenhum.

## Etapa 3 — Criar as tabelas (rodar o SQL)

1. No menu lateral do Supabase, abra **SQL Editor** → **New query**.
2. Abra o arquivo `supabase/migrations/0001_init.sql` do projeto, copie **todo** o conteúdo e cole no editor.
3. Clique em **Run**. Deve aparecer "Success".
   - Isto cria todas as tabelas (profiles, services, availability, time_blocks,
     clients, appointments, client_notes), as políticas de segurança (RLS), a
     trava anti-conflito de horário e a função `busy_intervals`.
4. (Opcional) O arquivo `supabase/seed.sql` não tem dados obrigatórios — pode pular.

## Etapa 4 — Configurar a autenticação

Em **Authentication** → **Sign In / Providers** → **Email**:

- Deixe o provedor **Email** ativado.
- Para testar rápido, você pode desativar **Confirm email** (assim a conta entra
  sem precisar clicar num link de e-mail). Em produção, mantenha ativado.

Em **Authentication** → **URL Configuration**:

- Em **Site URL**, coloque a URL onde o site vai rodar. Para testar local agora:
  `http://localhost:3000`. Quando hospedar, troque pela URL pública.

## Etapa 5 — Preencher o config do frontend

Abra `public/js/config.js` e edite:

```js
export const LOCAL_MODE = false;                     // <- desliga o modo local
export const SUPABASE_URL = "https://SEU-PROJETO.supabase.co";
export const SUPABASE_ANON_KEY = "sua-anon-public-key";
```

Só essas três linhas. **Nunca** coloque a service_role aqui.

## Etapa 6 — Publicar as Edge Functions

As funções validam disponibilidade e respostas no servidor. Você precisa da
**Supabase CLI**.

1. Instale a CLI: https://supabase.com/docs/guides/cli (no Windows, via Scoop ou
   baixando o executável). Confirme com `supabase --version`.
2. Na raiz do projeto, rode:

   ```bash
   supabase login
   supabase link --project-ref SEU_PROJECT_REF
   ```

   (o `PROJECT_REF` é a parte `xxxxxxxx` da sua Project URL.)

3. Faça o deploy das duas funções:

   ```bash
   supabase functions deploy create-booking --no-verify-jwt
   supabase functions deploy appointment-response --no-verify-jwt
   ```

   `--no-verify-jwt` é necessário porque a página pública e a de confirmação são
   anônimas (cliente sem login). As funções usam a service_role que o Supabase
   injeta automaticamente — você não precisa configurar segredo nenhum.

## Etapa 7 — Testar local apontando para o Supabase

1. Suba o site local como sempre:
   ```bash
   npx serve public -l 3000
   ```
   (no Windows com política restritiva: `cmd /c "npx.cmd --yes serve public -l 3000"`)
2. Abra http://localhost:3000 e **crie uma conta** (agora ela vai para o Supabase).
3. Faça um teste completo: serviço → horários → agendamento público → confirmar.
4. Confira no Supabase (**Table Editor**) que os registros aparecem nas tabelas.

## Etapa 8 — Hospedar para clientes acessarem de verdade

Para o link funcionar no celular de qualquer cliente, hospede a pasta `public/`:

**Opção Netlify (simples):**
1. Crie conta em https://netlify.com
2. Arraste a pasta `public/` na área "Deploy manually" (ou conecte o repositório).
3. Você recebe uma URL tipo `https://agendaai.netlify.app`.
4. Volte ao Supabase → **Authentication → URL Configuration** e ponha essa URL
   em **Site URL**. Atualize também o `config.js` se necessário e republique.

Pronto: o link público `https://sua-url/agendar.html?slug=...` funciona em qualquer lugar.

---

## Segurança (já implementado, mas confira)

- **RLS ativo** em todas as tabelas: cada profissional só vê/edita os próprios dados.
- Página pública lê só o necessário (perfil, serviços ativos, horários) — nunca
  anotações privadas nem telefone de outros clientes.
- A criação de agendamento e as respostas por token passam pelas Edge Functions
  (service_role no servidor), nunca pela chave secreta no navegador.
- Trava anti-conflito de horário no banco (constraint de exclusão).

## Variáveis de ambiente (sem segredos)

| Nome | Onde | Público? |
|------|------|----------|
| SUPABASE_URL | public/js/config.js | sim |
| SUPABASE_ANON_KEY | public/js/config.js | sim (respeita RLS) |
| SUPABASE_SERVICE_ROLE_KEY | injetada pelo Supabase nas Edge Functions | **secreta, nunca no frontend** |

## Voltar ao modo local

É só pôr `LOCAL_MODE = true` de novo no `config.js`. Os dois modos continuam funcionando.

# Configuração do Supabase — AgendaAí

Passo a passo para colocar o backend no ar. Nada é simulado: enquanto o Supabase
não estiver configurado, o frontend mostra um aviso e as ações de rede falham
com mensagem clara.

## 1. Criar o projeto

1. Acesse https://supabase.com e crie um projeto novo.
2. Em **Project Settings → API**, anote:
   - **Project URL** (`SUPABASE_URL`)
   - **anon public key** (`SUPABASE_ANON_KEY`) — pode ir para o navegador
   - **service_role key** — **secreta**, nunca vai para o frontend

## 2. Criar o schema

No painel do Supabase, abra **SQL Editor** e rode, nesta ordem:

1. `supabase/migrations/0001_init.sql`
2. `supabase/seed.sql` (opcional — apenas dados de exemplo)

Isso cria tabelas, RLS, a constraint anti-conflito e a função `busy_intervals`.

## 3. Configurar autenticação

Em **Authentication → Providers → Email**:

- Mantenha o provedor de e-mail ativado.
- Para testes rápidos, desative "Confirm email" (**Authentication → Sign In / Providers**),
  ou confirme os e-mails manualmente. Em produção, mantenha a confirmação ativada.
- Em **URL Configuration**, adicione a URL onde você serve o frontend
  (ex.: `http://localhost:3000`) em *Site URL* e *Redirect URLs*.

## 4. Deploy da Edge Function

Instale a [Supabase CLI](https://supabase.com/docs/guides/cli) e rode, na raiz do projeto:

```bash
supabase login
supabase link --project-ref SEU_PROJECT_REF
supabase functions deploy create-booking --no-verify-jwt
```

> `--no-verify-jwt` é necessário porque a página pública de agendamento é anônima.
> A função injeta `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` automaticamente no
> ambiente dela — você não precisa defini-las manualmente no deploy.

Para testar localmente:

```bash
supabase functions serve create-booking --no-verify-jwt --env-file supabase/.env.local
```

## 5. Configurar o frontend

Edite `public/js/config.js` e preencha:

```js
export const SUPABASE_URL = "https://SEU-PROJETO.supabase.co";
export const SUPABASE_ANON_KEY = "sua-anon-key-publica";
```

A URL da Edge Function é derivada automaticamente de `SUPABASE_URL`
(`{SUPABASE_URL}/functions/v1/create-booking`).

## 6. Servir o frontend

Qualquer servidor estático funciona. Exemplos:

```bash
npx serve public
# ou
python -m http.server 3000 --directory public
```

Depois:
- Painel do profissional: `http://localhost:3000/` → cadastre-se e faça login.
- Link público: `http://localhost:3000/agendar.html?slug=SEU-SLUG`.

## 7. Roteiro de testes

1. **Cadastro/login:** crie um profissional; confirme que o perfil foi criado com um `slug`.
2. **Serviços:** cadastre serviços (nome, duração, preço e imagem opcional).
3. **Disponibilidade:** defina dias/horários; adicione um bloqueio.
4. **Agendamento público:** abra o link, escolha serviço e data; confira que só
   aparecem horários livres (sem conflito com bloqueios/pedidos/confirmados).
5. **Pedido:** finalize; confirme que entrou como `requested` no painel e que o
   link `wa.me` abre com a mensagem preenchida.
6. **Confirmação:** no painel, confirme o pedido; tente agendar o mesmo horário
   de novo pela página pública e confirme que ele não aparece mais / é recusado.
7. **Conflito confirmado:** a constraint `appointments_no_overlap` impede dois
   confirmados sobrepostos — teste confirmando dois pedidos no mesmo horário.

# Conti casa

App web (HTML + JavaScript, nessun build) per tenere sotto controllo due conti personali e un conto comune, mese per mese. Login e database su [Supabase](https://supabase.com) (piano gratuito), hosting su GitHub Pages.

I dati personali stanno **solo su Supabase**, mai nel repository.

## Configurazione

1. **Supabase**: crea un progetto (regione europea). In *Authentication → Sign In / Providers* lascia attivo Email e **disattiva "Allow new users to sign up"**. In *Authentication → Users → Add user* crea i 2 utenti con *Auto Confirm User*.
2. **SQL Editor**: esegui `schema.sql` (tabelle, RLS, permessi). I dati iniziali sono in `seed.sql`, che è locale e **non va committato**.
3. **`config.js`**: inserisci *Project URL* e *Publishable key* (Project Settings → API). Sono chiavi pubbliche per design; non inserire mai la secret key o la service_role key.
4. **GitHub Pages**: *Settings → Pages → Deploy from a branch → `main` / root*.
5. **Supabase → Authentication → URL Configuration**: imposta *Site URL* e *Redirect URLs* con l'URL di GitHub Pages (serve al link di reset password).

## Prova in locale

```
python3 -m http.server 8000
```
poi apri `http://localhost:8000` (aggiungi quell'URL ai *Redirect URLs* di Supabase solo se vuoi provare il reset password).

## Test dei calcoli

```
node test.local.js
```
Usa i dati di `seed.sql` (locale, come `test.local.js`: entrambi esclusi da git) e confronta i saldi attesi. Senza `seed.sql` il test viene saltato.

## Nota sul piano gratuito

Se nessuno usa l'app per 7 giorni Supabase mette in pausa il progetto (arriva prima un'email di avviso). Si riattiva dalla dashboard e i dati restano.

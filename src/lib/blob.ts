/*
  Vercel Blob auth options.

  `vercel env pull` writes BOTH `VERCEL_OIDC_TOKEN` and `BLOB_STORE_ID`
  into .env.local, and @vercel/blob's auth resolver prefers OIDC over the
  read-write token when both are present. Local ("development") OIDC isn't
  enabled, so `put`/`del` then fail with BlobOidcEnvironmentNotAllowedError.

  Passing the read-write token explicitly wins that resolution (it's the
  first branch checked), and behaves identically on Vercel, where a
  connected store injects `BLOB_READ_WRITE_TOKEN` into the deployment env.
  When the token is unset this is a harmless no-op (`{ token: undefined }`),
  and the library falls back to its normal env resolution.

  The store's read-write token is exposed as `TO_DO_READ_WRITE_TOKEN`
  (the env-var name chosen when the store was created); we fall back to the
  conventional `BLOB_READ_WRITE_TOKEN` if that's what's set instead. The
  store id is parsed from the token itself, so a stray `BLOB_STORE_ID` from
  another store in the env is irrelevant here.
*/
export const blobToken = () =>
  process.env.TO_DO_READ_WRITE_TOKEN ?? process.env.BLOB_READ_WRITE_TOKEN;

export const blobAuth = () => ({ token: blobToken() });

/**
 * The access-token input every file-manager form that changes state includes.
 *
 * A plain `<form>` cannot set an `Authorization` header, so the browser path
 * sends the token as a form field named `token`; the Server Action reads it
 * through `authorizeMutation` (src/app/_auth/mutation-auth.ts). It is a
 * password input so the value is not shown. Works in Server and Client
 * Components (no hooks, no state).
 */
export default function TokenField({ id = 'token' }: { id?: string }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm mb-1 text-purple-200">
        Access token
      </label>
      <input
        id={id}
        name="token"
        type="password"
        autoComplete="off"
        required
        className="w-full p-2 rounded bg-black/20 border border-white/10 text-white"
      />
    </div>
  );
}

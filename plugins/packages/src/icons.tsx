export function Icon({ name }: { name: "search" | "reset" }) {
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "search" ? <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></> : <><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/></>}
  </svg>;
}

/**
 * Marque Médéré — wordmark typographique sobre (Aileron).
 * Placeholder texte tant que le logo officiel n'est pas fourni.
 */
export function Brand({ className = '' }: { className?: string }) {
  return (
    <span className={`select-none font-semibold tracking-tight text-ink ${className}`}>
      Médéré
      <span className="ml-2 font-normal text-muted">· Signatures</span>
    </span>
  );
}

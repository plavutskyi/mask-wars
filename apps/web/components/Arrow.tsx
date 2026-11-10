export function Arrow({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} viewBox="0 0 24 12" aria-label="to" role="img">
      <path d="M0 6h21M16 1l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

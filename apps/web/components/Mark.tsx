/** The mark, BRANDBOOK §2. Ice on ink only. */
export function Mark({ className, micro = false }: { className?: string | undefined; micro?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 240 280" aria-hidden focusable="false">
      <path
        fill="currentColor"
        d={
          micro
            ? 'M40 0 L120 92 L200 0 L230 90 L142 146 L142 194 L213 146 L168 280 L120 226 L72 280 L27 146 L98 194 L98 146 L10 90Z'
            : 'M47 0 L120 87 L193 0 L224 95 L138 155 L138 179 L214 126 L164 280 L120 228 L76 280 L26 126 L102 179 L102 155 L16 95Z'
        }
      />
    </svg>
  );
}

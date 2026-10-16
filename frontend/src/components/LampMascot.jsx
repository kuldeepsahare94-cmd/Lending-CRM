// A friendly lamp mascot. status: 'idle' | 'checking' | 'success' | 'error'
export default function LampMascot({ status = 'idle' }) {
  const lit = status === 'success';
  const sad = status === 'error';
  const glowOpacity = lit ? 1 : status === 'checking' ? 0.4 : 0.15;

  return (
    <svg viewBox="0 0 200 220" width="140" height="154" className="mx-auto select-none">
      {/* glow */}
      <circle cx="100" cy="70" r="55" fill="#FDE68A" opacity={glowOpacity} style={{ filter: 'blur(18px)', transition: 'opacity 0.4s ease' }} />

      {/* shade */}
      <path d="M55 75 L80 20 L120 20 L145 75 Z" fill={lit ? '#F3C64B' : '#6B5B95'} stroke="#2A1B4D" strokeWidth="3" style={{ transition: 'fill 0.4s ease' }} />
      <ellipse cx="100" cy="75" rx="45" ry="8" fill={lit ? '#FFDD7A' : '#7C6BAE'} stroke="#2A1B4D" strokeWidth="3" />

      {/* bulb glow inside shade */}
      <circle cx="100" cy="55" r="14" fill="#FFF6D6" opacity={lit ? 1 : 0.2} style={{ transition: 'opacity 0.4s ease' }} />

      {/* pole */}
      <rect x="96" y="83" width="8" height="55" fill="#2A1B4D" />

      {/* base */}
      <ellipse cx="100" cy="145" rx="38" ry="10" fill="#2A1B4D" />

      {/* face on the shade */}
      {sad ? (
        <>
          <circle cx="85" cy="55" r="4" fill="#2A1B4D" />
          <circle cx="115" cy="55" r="4" fill="#2A1B4D" />
          <path d="M88 68 Q100 60 112 68" stroke="#2A1B4D" strokeWidth="3" fill="none" strokeLinecap="round" />
        </>
      ) : (
        <>
          <path d="M81 55 Q85 50 89 55" stroke="#2A1B4D" strokeWidth="3" fill="none" strokeLinecap="round" />
          <path d="M111 55 Q115 50 119 55" stroke="#2A1B4D" strokeWidth="3" fill="none" strokeLinecap="round" />
          <path d="M88 63 Q100 72 112 63" stroke="#2A1B4D" strokeWidth="3" fill="none" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

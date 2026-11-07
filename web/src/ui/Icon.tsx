const paths = {
  close: 'M6 6l12 12M6 18L18 6',
  runs: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z M10 5h4 M10 19h4',
  fixtures: 'm3 7 9-4 9 4v11l-9 4-9-4Z M3 7l9 4 9-4 M12 11v11 M7 5l9 4',
  history: 'M4 3v17h17 M8 15l4-6 4 3 5-7',
  plus: 'M12 5v14 M5 12h14',
  arrow: 'M5 12h14 M14 7l5 5-5 5',
}
export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  )
}

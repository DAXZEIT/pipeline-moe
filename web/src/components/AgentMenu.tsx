import { useEffect, useRef, useState } from "react"

export interface AgentMenuItem {
  icon: string
  label: string
  onClick: () => void
  /** Shows a ✓ on the right — for state toggles (default, parallel). */
  checked?: boolean
  disabled?: boolean
  /** Secondary detail line shown in smaller text below the label. */
  hint?: string
  /** Destructive styling (red), e.g. Kick. */
  danger?: boolean
  /** Draw a divider above this item. */
  separatorBefore?: boolean
}

/** A compact "⋯" overflow menu for an agent card. The dropdown is positioned
 *  with `position: fixed` (anchored to the button) so it is never clipped by the
 *  roster's scroll container. Closes on outside-click, scroll, resize, or after
 *  an item is chosen. */
export function AgentMenu({ items }: { items: AgentMenuItem[] }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    // capture:true so the roster list's own scroll also closes the menu.
    window.addEventListener("scroll", close, true)
    window.addEventListener("resize", close)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("resize", close)
    }
  }, [open])

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) {
      // The roster sits on the LEFT edge of the app. A right-anchored menu
      // opens leftward, and wide items (fused-seat "Join … · different model —
      // the server will refuse" hints) grew the menu until it overflowed the
      // viewport's left edge and clipped. Open RIGHTWARD from the button (into
      // the wide transcript area) and clamp within the viewport so the menu
      // never clips on either side. MENU_W must match the dropdown's max-width.
      const MENU_W = 260
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - MENU_W - 8))
      setPos({ top: rect.bottom + 4, left })
    }
    setOpen(true)
  }

  return (
    <div className="agent-menu" ref={wrapRef}>
      <button
        ref={btnRef}
        className="agent-menu-btn"
        title="Agent actions"
        aria-label="Agent actions"
        aria-haspopup="menu"
        onClick={toggle}
      >
        ⋯
      </button>
      {open && (
        <div className="agent-menu-dropdown" role="menu" style={{ top: pos.top, left: pos.left }}>
          {items.map((it, i) => (
            <div key={i}>
              {it.separatorBefore && <div className="agent-menu-sep" />}
              <button
                className={`agent-menu-item${it.danger ? " danger" : ""}`}
                role="menuitem"
                disabled={it.disabled}
                onClick={() => {
                  it.onClick()
                  setOpen(false)
                }}
              >
                <span className="agent-menu-icon">{it.icon}</span>
                <span className="agent-menu-label">
                  <span>{it.label}</span>
                  {it.hint && <span className="agent-menu-hint">{it.hint}</span>}
                </span>
                {it.checked && <span className="agent-menu-check">✓</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

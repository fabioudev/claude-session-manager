import { ArrowLeft } from 'lucide-react'
import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Page not found</h1>
          <p className="page-sub">This address does not match a view on the board.</p>
        </div>
      </div>
      <div className="empty">
        <h3>Nothing is here.</h3>
        <p>The board, coordination stream and settings are one click away.</p>
        <div className="empty-actions">
          <Link className="btn" to="/">
            <ArrowLeft size={13} aria-hidden="true" />
            Back to the board
          </Link>
        </div>
      </div>
    </>
  )
}

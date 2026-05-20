interface Props {
  message?: string
}

export default function LoadingSpinner({ message = 'Loading...' }: Props) {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <div className="flex gap-2 justify-center mb-3">
          <span className="loading-dot w-3 h-3 bg-blue-400 rounded-full inline-block" />
          <span className="loading-dot w-3 h-3 bg-blue-400 rounded-full inline-block" />
          <span className="loading-dot w-3 h-3 bg-blue-400 rounded-full inline-block" />
        </div>
        <p className="text-sm text-gray-400">{message}</p>
      </div>
    </div>
  )
}

'use client';

export default function FileList({ files }: { files: any[] }) {
  if (files.length === 0) {
    return (
      <div className="text-center py-8 text-purple-200">
        <p>No files uploaded yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {files.map((file, idx) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: files lack stable unique id
          key={idx}
          className="bg-white/5 hover:bg-white/10 transition-colors rounded-lg p-4 border border-white/10"
        >
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <p className="text-white font-medium">{file.name}</p>
              <p className="text-purple-300 text-sm">{(file.size / 1024).toFixed(2)} KB</p>
            </div>
            <svg
              className="w-5 h-5 text-purple-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <title>File icon</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
              />
            </svg>
          </div>
        </div>
      ))}
    </div>
  );
}

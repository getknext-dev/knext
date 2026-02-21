'use client';

import { useState } from 'react';
import { uploadFile } from '@/app/actions';

export default function UploadForm() {
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');

  async function handleSubmit(formData: FormData) {
    setUploading(true);
    setMessage('');

    const result = await uploadFile(formData);

    if (result.error) {
      setMessage(result.error);
    } else {
      setMessage('File uploaded successfully!');
    }

    setUploading(false);
  }

  return (
    <form action={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="file" className="block text-sm font-medium text-purple-200 mb-2">
          Choose a file
        </label>
        <input
          type="file"
          id="file"
          name="file"
          required
          className="block w-full text-sm text-white
            file:mr-4 file:py-2 file:px-4
            file:rounded-lg file:border-0
            file:text-sm file:font-semibold
            file:bg-purple-600 file:text-white
            hover:file:bg-purple-700
            file:cursor-pointer cursor-pointer
            bg-white/5 rounded-lg border border-white/20 p-2"
        />
      </div>

      <button
        type="submit"
        disabled={uploading}
        className="w-full bg-gradient-to-r from-purple-600 to-pink-600 
          hover:from-purple-700 hover:to-pink-700 
          disabled:from-gray-600 disabled:to-gray-600
          text-white font-semibold py-3 px-6 rounded-lg
          transition-all duration-200 shadow-lg hover:shadow-xl
          disabled:cursor-not-allowed"
      >
        {uploading ? 'Uploading...' : 'Upload File'}
      </button>

      {message && (
        <p className={`text-sm ${message.includes('success') ? 'text-green-400' : 'text-red-400'}`}>
          {message}
        </p>
      )}
    </form>
  );
}

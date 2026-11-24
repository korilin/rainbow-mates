import {
  BookOpenText, FileArchive, FileCode, FileImage, FileMusic, FileSpreadsheet, FileText,
  FileVideoCamera, NotebookText, Presentation,
} from 'lucide-react'
import { mediaType } from '../shared/content-links.mjs'

export function fileIcon(name = '', mime = mediaType(name)) {
  if (mime.startsWith('image/')) return FileImage
  if (mime.startsWith('video/')) return FileVideoCamera
  if (mime.startsWith('audio/')) return FileMusic
  const extension = /\.([^.\/]+)$/u.exec(name)?.[1].toLowerCase() || ''
  if (/^(csv|tsv|xls|xlsx|ods|numbers)$/u.test(extension)) return FileSpreadsheet
  if (/^(ppt|pptx|odp|key)$/u.test(extension)) return Presentation
  if (/^(js|jsx|ts|tsx|json|py|rb|rs|go|java|kt|swift|c|h|cpp|html|css|sh|yml|yaml|toml|xml|sql)$/u.test(extension)) return FileCode
  if (/^(zip|rar|7z|tar|gz|bz2|xz|dmg)$/u.test(extension)) return FileArchive
  if (/^(md|markdown|mdx)$/u.test(extension)) return NotebookText
  if (/^(pdf|epub)$/u.test(extension)) return BookOpenText
  return FileText
}

import type { Page } from '@playwright/test'

export async function openVideoPathDialog(page: Page) {
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Open video…' }).click()

  return page.getByRole('dialog', { name: 'Load a video by absolute path' })
}

export async function loadVideoByPath(page: Page, path: string) {
  const dialog = await openVideoPathDialog(page)
  await dialog.getByRole('textbox', { name: 'Absolute video path' }).fill(path)
  await dialog.getByRole('button', { name: 'Load video' }).click()
  return dialog
}

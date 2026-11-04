// UIKitCatalog navigation. Accessibility labels are used instead of screen coordinates.
import type { Browser } from 'webdriverio'

export async function open(driver: Browser, screen: string) {
  const cell = driver.$(`~${screen}`)
  await cell.scrollIntoView()
  await cell.waitForDisplayed()
  await cell.click()
}

// Small steps shared by the Android scenarios. Every step waits for its element (R8).
import type { Browser } from 'webdriverio'

export const byText = (text: string) => `android=new UiSelector().text("${text}")`
export const byId = (id: string) => `android=new UiSelector().resourceId("${id}")`

// Taps each item in order, e.g. open(driver, 'Views', 'Controls').
export async function open(driver: Browser, ...items: string[]) {
  for (const item of items) await tap(driver, byText(item))
}

export async function tap(driver: Browser, selector: string) {
  const element = driver.$(selector)
  await element.waitForDisplayed()
  await element.click()
}

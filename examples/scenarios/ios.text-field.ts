import type { Scenario } from '@nowait-qa/sdk'
import { open } from './helpers/ios.ts'

export default {
  id: 'ios.text-field',
  platforms: ['ios'],
  async run(driver) {
    await open(driver, 'Text Fields')
    const field = driver.$('-ios class chain:**/XCUIElementTypeTextField[1]')
    await field.waitForDisplayed()
    await field.setValue('nowait')
    await driver.waitUntil(async () => (await field.getAttribute('value')) === 'nowait')
  },
} satisfies Scenario

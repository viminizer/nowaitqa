import type { Scenario } from '@nowait-qa/sdk'
import { open } from './helpers/ios.ts'

export default {
  id: 'ios.alert',
  platforms: ['ios'],
  async run(driver) {
    await open(driver, 'Alert Views')
    await open(driver, 'Simple')
    const alert = driver.$('XCUIElementTypeAlert')
    await alert.waitForDisplayed()
    if (!(await driver.getAlertText()).includes('A Short Title Is Best')) {
      throw new Error('unexpected alert text')
    }
    await driver.dismissAlert()
    await alert.waitForDisplayed({ reverse: true })
  },
} satisfies Scenario

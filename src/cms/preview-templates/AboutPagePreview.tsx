import React from 'react'
import { AboutPageTemplate } from '../../templates/about-page-template'

const AboutPagePreview = ({ entry, widgetFor, getAsset }: any) => (
  <AboutPageTemplate
    title={entry.getIn(['data', 'title'])}
    aboutimage={entry.getIn(['data', 'aboutimage']) ? { src: getAsset(entry.getIn(['data', 'aboutimage'])).toString() } : undefined}
    content={widgetFor('body')}
  />
)

export default AboutPagePreview

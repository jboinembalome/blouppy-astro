import React from 'react'
import { IndexPageTemplate } from '../../templates/index-page-template'

const IndexPagePreview = ({ entry }: any) => {
  const data = entry.getIn(['data']).toJS()

  if (data) {
    return (
      <IndexPageTemplate
        title={data.title}
        heading={data.heading}
        subheading={data.subheading}
      />
    )
  } else {
    return <div>Loading...</div>
  }
}

export default IndexPagePreview

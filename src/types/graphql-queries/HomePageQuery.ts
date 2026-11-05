
export type HomePageQuery = {
    markdownRemark: {
        frontmatter: {
            title: string;
            heading: string;
            subheading: string;
            mainpitch: {
                title: string;
                description: string;
            };
        }
    };
};
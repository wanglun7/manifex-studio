FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PIP_BREAK_SYSTEM_PACKAGES=1

RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g; s|http://deb.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    fd-find \
    ffmpeg \
    file \
    git \
    imagemagick \
    jq \
    less \
    libimage-exiftool-perl \
    libreoffice \
    openssh-client \
    pandoc \
    p7zip-full \
    poppler-utils \
    procps \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    tesseract-ocr \
    tesseract-ocr-chi-sim \
    tesseract-ocr-eng \
    tini \
    unzip \
    wget \
    zip \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir \
    beautifulsoup4 \
    chardet \
    ebooklib \
    lxml \
    markdownify \
    mammoth \
    odfpy \
    openpyxl \
    pandas \
    pillow \
    pdfplumber \
    pymupdf \
    pypdf \
    pytesseract \
    python-docx \
    python-magic \
    python-pptx \
    xlrd \
    xlsxwriter \
    requests

RUN npm install -g \
    @larksuite/cli@latest \
    dingtalk-workspace-cli@latest \
    @wecom/cli@latest \
  && curl -fsSL https://raw.githubusercontent.com/wps365-open/cli/main/install.sh \
    | WPS365_INSTALL_DIR=/usr/local/bin bash

WORKDIR /workspace

ENTRYPOINT ["tini", "--"]
CMD ["sleep", "infinity"]

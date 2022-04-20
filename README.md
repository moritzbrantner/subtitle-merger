# Subtitle-Merger

Merges two .ass-files into one, so that two subtitles are shown simultaneously.

## Installation

Simply download the repository and run the following command:

```
git clone https://github.com/moritzbrantner/subtitle-merger
pip install -r requirements.txt
```

## Usage

Try out with two subtitle files for your average video.mp4:

```cmd
python subtitle-merger.py --primary-input=video.en-US.ass --secondary-input=video.de-DE.ass
```

You will then get a merged file called `video.en-US+de-DE.ass`,
which can be added to your video as subtitles.

## Example

This short gif shows the result of the above command, a quick 
video with two subtitle tracks:

![](untitled.GIF)

As you can see, two subtitle tracks are shown simultaneously.


## License

MIT